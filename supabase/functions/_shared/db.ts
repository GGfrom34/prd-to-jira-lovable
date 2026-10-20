import type { BudgetStore, DenyReason, ReserveArgs, SettleArgs } from "./guardrails.ts";

export const STEPS = [
  "new",
  "reviewed",
  "improved",
  "finalized",
  "signed_off",
  "split_proposed",
  "split_revised",
  "link_submitted",
  "surveyed",
] as const;
export type Step = (typeof STEPS)[number];
export type StepResult = "ok" | "no_session" | "wrong_step" | "busy";

export interface Db extends BudgetStore {
  startSession(visitor: string, maxPerVisitor: number): Promise<string | null>;
  beginStep(session: string, allowed: readonly Step[]): Promise<StepResult>;
  finishStep(session: string, next: Step): Promise<void>;
  abortStep(session: string): Promise<void>;
  capacityAvailable(day: string, globalCap: number, minTokens: number): Promise<boolean>;
}

// Calls the SQL functions through Supabase's PostgREST endpoint with the
// service-role key. Argument names must match the SQL parameter names exactly;
// a test checks this against the real migration.
export function rpcDb(supabaseUrl: string, serviceKey: string, fetchImpl: typeof fetch = fetch): Db {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    // New-style keys (sb_secret_...) are not JWTs and must go in apikey only;
    // sending them as a Bearer token is rejected. Legacy keys are JWTs and take both.
    const headers: Record<string, string> = { apikey: serviceKey, "content-type": "application/json" };
    if (serviceKey.startsWith("eyJ")) headers.authorization = `Bearer ${serviceKey}`;
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`rpc ${name} failed with HTTP ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    startSession: (visitor, maxPerVisitor) =>
      rpc<string | null>("start_session", { p_visitor: visitor, p_max_per_visitor: maxPerVisitor }),
    beginStep: (session, allowed) => rpc<StepResult>("begin_step", { p_session: session, p_allowed: [...allowed] }),
    finishStep: async (session, next) => {
      await rpc("finish_step", { p_session: session, p_next: next });
    },
    abortStep: async (session) => {
      await rpc("abort_step", { p_session: session });
    },
    capacityAvailable: (day, globalCap, minTokens) =>
      rpc<boolean>("capacity_available", { p_day: day, p_global_cap: globalCap, p_min: minTokens }),
    reserve: (a: ReserveArgs) =>
      rpc<"ok" | DenyReason>("reserve_tokens", {
        p_day: a.day,
        p_visitor: a.visitor,
        p_session: a.session,
        p_estimate: a.estimate,
        p_global_cap: a.caps.global,
        p_visitor_cap: a.caps.visitor,
        p_session_cap: a.caps.session,
      }),
    settle: async (a: SettleArgs) => {
      await rpc("settle_tokens", {
        p_day: a.day,
        p_visitor: a.visitor,
        p_session: a.session,
        p_estimate: a.estimate,
        p_actual: a.actual,
      });
    },
  };
}
