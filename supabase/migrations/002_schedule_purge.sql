-- Deletes counters older than yesterday and sessions older than 48 hours, every
-- day at 03:00 UTC, so the privacy notice's "deleted after two days" is true.
-- Needs the pg_cron extension, which is available on Supabase.

create extension if not exists pg_cron with schema pg_catalog;

-- Enabling the extension from a migration does not give postgres access to the
-- scheduler's schema the way the dashboard toggle does.
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

grant execute on function public.purge_old(date) to postgres;

do $$
declare
  v_user text;
begin
  -- A cron job runs as whoever scheduled it. The migration's temporary login
  -- role will not exist when the job fires, so schedule it as postgres.
  set local role postgres;

  -- Same call the job makes, so a permission problem fails the migration now
  -- rather than silently at 03:00.
  perform public.purge_old(current_date - 1);

  perform cron.schedule(
    'prd-assistant-purge',
    '0 3 * * *',
    $job$select public.purge_old(current_date - 1)$job$
  );

  -- Checked while still postgres: the migration's own role has no access to cron.
  select username into v_user from cron.job where jobname = 'prd-assistant-purge';
  if v_user is distinct from 'postgres' then
    raise exception 'purge job runs as %, expected postgres', coalesce(v_user, '(job not found)');
  end if;

  reset role;
end;
$$;
