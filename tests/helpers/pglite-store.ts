import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { BudgetStore, ReserveArgs, SettleArgs, DenyReason } from "../../supabase/functions/_shared/guardrails.ts";
import type { Db, StepResult } from "../../supabase/functions/_shared/db.ts";

const MIGRATION = readFileSync(
  new URL("../../supabase/migrations/001_budget_and_sessions.sql", import.meta.url),
  "utf8",
);

// Supabase provides these roles and default grants; plain Postgres does not.
// Without the default grants, the migration's revokes would have nothing to remove.
const ROLES = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
`;
const DEFAULT_GRANTS = `
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

// withDefaultGrants: false models a platform that no longer grants new tables to
// the API roles automatically, so the migration must grant what it needs itself.
export async function freshDb(opts: { withDefaultGrants?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  if (opts.withDefaultGrants !== false) await db.exec(DEFAULT_GRANTS);
  await db.exec(MIGRATION);
  return db;
}

export function pgliteStore(db: PGlite): BudgetStore {
  return {
    async reserve(a: ReserveArgs): Promise<"ok" | DenyReason> {
      const res = await db.query<{ r: string }>(
        "select reserve_tokens($1::date, $2, $3::uuid, $4, $5, $6, $7) as r",
        [a.day, a.visitor, a.session, a.estimate, a.caps.global, a.caps.visitor, a.caps.session],
      );
      return res.rows[0].r as "ok" | DenyReason;
    },
    async settle(a: SettleArgs): Promise<void> {
      await db.query("select settle_tokens($1::date, $2, $3::uuid, $4, $5)", [
        a.day,
        a.visitor,
        a.session,
        a.estimate,
        a.actual,
      ]);
    },
  };
}

export function pgliteDb(db: PGlite): Db {
  const budget = pgliteStore(db);
  return {
    ...budget,
    async startSession(visitor, maxPerVisitor) {
      const res = await db.query<{ id: string | null }>("select start_session($1, $2) as id", [visitor, maxPerVisitor]);
      return res.rows[0].id;
    },
    async beginStep(session, allowed) {
      const res = await db.query<{ r: StepResult }>("select begin_step($1::uuid, $2::text[]) as r", [session, [...allowed]]);
      return res.rows[0].r;
    },
    async finishStep(session, next) {
      await db.query("select finish_step($1::uuid, $2)", [session, next]);
    },
    async abortStep(session) {
      await db.query("select abort_step($1::uuid)", [session]);
    },
    async capacityAvailable(day, globalCap, minTokens) {
      const res = await db.query<{ a: boolean }>("select capacity_available($1::date, $2, $3) as a", [day, globalCap, minTokens]);
      return res.rows[0].a;
    },
  };
}

export async function newSession(db: PGlite, visitor: string): Promise<string> {
  const res = await db.query<{ id: string }>("select start_session($1, 1000) as id", [visitor]);
  return res.rows[0].id;
}

export async function counters(
  db: PGlite,
  day: string,
  visitor: string,
  session: string,
): Promise<{ global: number; visitor: number; session: number }> {
  const one = async (sql: string, params: unknown[]) => {
    const res = await db.query<{ n: number }>(sql, params);
    return res.rows[0]?.n ?? 0;
  };
  return {
    global: await one(
      "select used::int as n from token_usage where day = $1::date and scope = 'global' and key = 'all'",
      [day],
    ),
    visitor: await one(
      "select used::int as n from token_usage where day = $1::date and scope = 'visitor' and key = $2",
      [day, visitor],
    ),
    session: await one("select tokens_used::int as n from sessions where id = $1::uuid", [session]),
  };
}
