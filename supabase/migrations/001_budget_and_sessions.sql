-- Token budget counters and session state for the PRD Assistant prototype.
-- Everything here is reached only through the Edge Functions' service role.

create table public.config (
  key   text primary key,
  value text not null
);
-- Kill switch. reserve_tokens() fails closed if this row is missing or not 'true'.
insert into public.config (key, value) values ('enabled', 'true');

create table public.token_usage (
  day   date   not null,
  scope text   not null check (scope in ('global', 'visitor')),
  key   text   not null,
  used  bigint not null default 0 check (used >= 0),
  primary key (day, scope, key)
);

create table public.sessions (
  id             uuid primary key default gen_random_uuid(),
  visitor_key    text not null,
  step           text not null default 'new' check (step in (
                   'new', 'reviewed', 'improved', 'finalized', 'signed_off',
                   'split_proposed', 'split_revised', 'link_submitted', 'surveyed')),
  revision_count int  not null default 0 check (revision_count between 0 and 1),
  tokens_used    bigint not null default 0 check (tokens_used >= 0),
  -- Set while a step is running, so two parallel requests cannot both pass the
  -- step check and spend twice. Treated as expired after a lease (see begin_step).
  busy_since     timestamptz,
  created_at     timestamptz not null default now()
);

-- Creates a session unless this visitor already has p_max_per_visitor of them.
-- visitor_key already includes the UTC day, so this is a per-day limit. The
-- advisory lock stops parallel requests racing past the limit.
create function public.start_session(p_visitor text, p_max_per_visitor int)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_count int;
  v_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_visitor, 0));
  select count(*) into v_count from sessions where visitor_key = p_visitor;
  if v_count >= p_max_per_visitor then
    return null;
  end if;
  insert into sessions (visitor_key) values (p_visitor) returning id into v_id;
  return v_id;
end;
$$;

-- Atomically checks the global, per-visitor and per-session caps and, if all
-- pass, adds p_estimate to all three. Returns 'ok' or the reason it was denied.
-- Rows are always locked in the same order (global, visitor, session) so
-- concurrent calls cannot deadlock.
create function public.reserve_tokens(
  p_day         date,
  p_visitor     text,
  p_session     uuid,
  p_estimate    bigint,
  p_global_cap  bigint,
  p_visitor_cap bigint,
  p_session_cap bigint
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_enabled text;
  v_global  bigint;
  v_visitor bigint;
  v_session bigint;
begin
  if p_estimate is null or p_estimate <= 0 then
    raise exception 'estimate must be positive';
  end if;

  select value into v_enabled from config where key = 'enabled';
  if v_enabled is distinct from 'true' then
    return 'disabled';
  end if;

  insert into token_usage (day, scope, key) values (p_day, 'global', 'all')
    on conflict do nothing;
  insert into token_usage (day, scope, key) values (p_day, 'visitor', p_visitor)
    on conflict do nothing;

  select used into v_global from token_usage
    where day = p_day and scope = 'global' and key = 'all' for update;
  select used into v_visitor from token_usage
    where day = p_day and scope = 'visitor' and key = p_visitor for update;
  select tokens_used into v_session from sessions
    where id = p_session for update;
  if not found then
    return 'no_session';
  end if;

  if v_global  + p_estimate > p_global_cap  then return 'global_cap';  end if;
  if v_visitor + p_estimate > p_visitor_cap then return 'visitor_cap'; end if;
  if v_session + p_estimate > p_session_cap then return 'session_cap'; end if;

  update token_usage set used = used + p_estimate
    where day = p_day and scope = 'global' and key = 'all';
  update token_usage set used = used + p_estimate
    where day = p_day and scope = 'visitor' and key = p_visitor;
  update sessions set tokens_used = tokens_used + p_estimate
    where id = p_session;

  return 'ok';
end;
$$;

-- Corrects a reservation to the real usage. p_day must be the day passed to
-- reserve_tokens, so a call that straddles midnight UTC settles against the
-- day it was charged to. Counters never go below zero; actual may exceed the
-- estimate, in which case the next reservation is denied sooner.
create function public.settle_tokens(
  p_day      date,
  p_visitor  text,
  p_session  uuid,
  p_estimate bigint,
  p_actual   bigint
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_delta bigint;
begin
  if p_estimate < 0 or p_actual < 0 then
    raise exception 'token counts must not be negative';
  end if;
  v_delta := p_actual - p_estimate;

  update token_usage set used = greatest(0, used + v_delta)
    where day = p_day and scope = 'global' and key = 'all';
  update token_usage set used = greatest(0, used + v_delta)
    where day = p_day and scope = 'visitor' and key = p_visitor;
  update sessions set tokens_used = greatest(0, tokens_used + v_delta)
    where id = p_session;
end;
$$;

-- Cheap check for the landing page: is there room for at least p_min tokens today?
create function public.capacity_available(
  p_day        date,
  p_global_cap bigint,
  p_min        bigint
)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce((select value from config where key = 'enabled'), '') = 'true'
     and coalesce((select used from token_usage
                    where day = p_day and scope = 'global' and key = 'all'), 0) + p_min <= p_global_cap;
$$;

-- Removes counters older than p_before_day and sessions older than 48 hours.
create function public.purge_old(p_before_day date)
returns void
language sql
set search_path = public
as $$
  delete from token_usage where day < p_before_day;
  delete from sessions where created_at < now() - interval '48 hours';
$$;

-- Step machine. begin_step atomically checks that the session is at one of the
-- allowed steps and is not already busy, then marks it busy. The caller runs the
-- step and then calls finish_step (success) or abort_step (failure, so the
-- visitor can retry). A busy mark older than the lease is ignored, so a crashed
-- function cannot strand a session. Returns 'ok', 'no_session', 'wrong_step'
-- or 'busy'.
create function public.begin_step(
  p_session       uuid,
  p_allowed       text[],
  p_lease_seconds int default 180
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_step text;
  v_busy timestamptz;
begin
  select step, busy_since into v_step, v_busy from sessions where id = p_session for update;
  if not found then
    return 'no_session';
  end if;
  if not (v_step = any(p_allowed)) then
    return 'wrong_step';
  end if;
  if v_busy is not null and v_busy > now() - make_interval(secs => p_lease_seconds) then
    return 'busy';
  end if;
  update sessions set busy_since = now() where id = p_session;
  return 'ok';
end;
$$;

create function public.finish_step(p_session uuid, p_next text)
returns void
language sql
set search_path = public
as $$
  update sessions
     set step = p_next,
         busy_since = null,
         revision_count = case when p_next = 'split_revised' then 1 else revision_count end
   where id = p_session;
$$;

create function public.abort_step(p_session uuid)
returns void
language sql
set search_path = public
as $$
  update sessions set busy_since = null where id = p_session;
$$;

-- Lock everything down: RLS on with no policies, and no direct grants or
-- function execute for the browser-facing roles. Only service_role (used by
-- the Edge Functions) can reach any of this.
alter table public.config      enable row level security;
alter table public.token_usage enable row level security;
alter table public.sessions    enable row level security;

revoke all on table public.config, public.token_usage, public.sessions
  from public, anon, authenticated;

-- Explicit, so it still works if the platform stops granting new tables to
-- service_role by default.
grant select, insert, update, delete on table public.config, public.token_usage, public.sessions
  to service_role;

revoke all on function
  public.start_session(text, int),
  public.reserve_tokens(date, text, uuid, bigint, bigint, bigint, bigint),
  public.settle_tokens(date, text, uuid, bigint, bigint),
  public.capacity_available(date, bigint, bigint),
  public.purge_old(date),
  public.begin_step(uuid, text[], int),
  public.finish_step(uuid, text),
  public.abort_step(uuid)
  from public, anon, authenticated;

grant execute on function
  public.start_session(text, int),
  public.reserve_tokens(date, text, uuid, bigint, bigint, bigint, bigint),
  public.settle_tokens(date, text, uuid, bigint, bigint),
  public.capacity_available(date, bigint, bigint),
  public.purge_old(date),
  public.begin_step(uuid, text[], int),
  public.finish_step(uuid, text),
  public.abort_step(uuid)
  to service_role;
