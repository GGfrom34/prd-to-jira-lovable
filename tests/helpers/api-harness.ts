import type { PGlite } from "@electric-sql/pglite";
import { handle, type Deps } from "../../supabase/functions/_shared/api.ts";
import type { MessageParams, MessageResponse } from "../../supabase/functions/_shared/anthropic.ts";
import type { Config } from "../../supabase/functions/_shared/config.ts";
import type { SurveyRow } from "../../supabase/functions/_shared/survey.ts";
import { freshDb, pgliteDb } from "./pglite-store.ts";

export const ORIGIN = "https://app.example";
export const IP = "203.0.113.9";
export const NOW = new Date("2026-10-20T12:00:00Z");
export const PRD = "SENTINEL_PRD_TEXT\n\n## Problem\nVisitors retype the same details every visit.\n";
export const SPLIT = {
  epic: { title: "Saved searches", description: "Summary.\nSource: PRD" },
  issues: [
    { type: "story", title: "Save a profile", description: "Save it.", acceptance_criteria: ["Button after result"] },
    { type: "task", title: "Accessibility", description: "Keyboard operable.", acceptance_criteria: [] },
  ],
};
export const FINDINGS = [
  { dimension: "success_metrics", severity: "blocker", section: "Goals", quote: null, issue: "No metric." },
  { dimension: "rollout_rollback", severity: "gap", section: "n/a", quote: null, issue: "No rollout plan." },
];
export const PROPOSALS = [
  { finding_id: "f1", question: "What target?", before: null, proposed_text: "Add a [20%] target." },
  { finding_id: "f2", question: "How does it ship?", before: "old text", proposed_text: "Ships in one PR." },
];
export const DECISIONS = [
  { finding_id: "f1", action: "edit", text: "My own 35% target" },
  { finding_id: "f2", action: "accept" },
];

export const USAGE = {
  report_findings: { input_tokens: 1000, output_tokens: 500 },
  propose_fixes: { input_tokens: 2000, output_tokens: 800 },
  return_prd: { input_tokens: 3000, output_tokens: 1500 },
  propose_breakdown: { input_tokens: 2000, output_tokens: 700 },
} as const;

const OUTPUTS: Record<string, unknown> = {
  report_findings: { verdict: "needs_targeted_fixes", summary: "Needs a metric.", findings: FINDINGS, skipped_dimensions: [] },
  propose_fixes: { proposals: PROPOSALS },
  return_prd: { prd_markdown: "# Improved PRD\n\nBetter." },
  propose_breakdown: SPLIT,
};

export function toolReply(tool: string, input: unknown = OUTPUTS[tool]): MessageResponse {
  return {
    content: [{ type: "tool_use", id: "tu", name: tool, input }],
    stop_reason: "tool_use",
    usage: USAGE[tool as keyof typeof USAGE],
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicKey: "sk-ant-TEST-KEY-123",
    model: "claude-sonnet-5",
    caps: { global: 1_000_000, visitor: 1_000_000, session: 1_000_000 },
    visitorSalt: "test-salt-0123456789",
    allowedOrigins: [ORIGIN],
    supabaseUrl: "https://proj.supabase.co",
    serviceRoleKey: "service-role-TEST-KEY",
    sheetUrl: "https://script.google.com/macros/s/TEST/exec",
    sheetSecret: "sheet-secret-TEST",
    version: "0.1",
    maxSessionsPerVisitor: 10,
    ...overrides,
  };
}

export type Harness = {
  pg: PGlite;
  deps: Deps;
  claudeCalls: MessageParams[];
  rows: SurveyRow[];
  call: (method: string, route: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; headers: Headers }>;
  session: () => Promise<string>;
  setStep: (session: string, step: string) => Promise<void>;
  stepOf: (session: string) => Promise<{ step: string; busy: boolean }>;
  globalUsed: () => Promise<number>;
};

export async function harness(
  opts: {
    config?: Partial<Config>;
    claude?: (params: MessageParams) => Promise<MessageResponse>;
    appendSurveyRow?: (row: SurveyRow) => Promise<void>;
    dbOverride?: (db: Deps["db"]) => Deps["db"];
  } = {},
): Promise<Harness> {
  const pg = await freshDb();
  const claudeCalls: MessageParams[] = [];
  const rows: SurveyRow[] = [];
  const baseDb = pgliteDb(pg);
  const deps: Deps = {
    config: testConfig(opts.config),
    db: opts.dbOverride ? opts.dbOverride(baseDb) : baseDb,
    claude:
      opts.claude ??
      (async (params) => {
        claudeCalls.push(params);
        return toolReply(params.tool_choice.name);
      }),
    appendSurveyRow:
      opts.appendSurveyRow ??
      (async (row) => {
        rows.push(row);
      }),
    now: () => NOW,
    randomId: () => "11111111-2222-3333-4444-555555555555",
  };
  if (opts.claude) {
    const inner = deps.claude;
    deps.claude = async (params) => {
      claudeCalls.push(params);
      return inner(params);
    };
  }

  const call: Harness["call"] = async (method, route, body, headers = {}) => {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": IP, ...headers },
    };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await handle(new Request(`https://proj.supabase.co/functions/v1/api/${route}`, init), deps);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };

  return {
    pg,
    deps,
    claudeCalls,
    rows,
    call,
    async session() {
      const r = await call("POST", "session");
      return r.json.session_id as string;
    },
    async setStep(session, step) {
      await pg.query("update sessions set step = $2 where id = $1::uuid", [session, step]);
    },
    async stepOf(session) {
      const res = await pg.query<{ step: string; busy: boolean }>(
        "select step, busy_since is not null as busy from sessions where id = $1::uuid",
        [session],
      );
      return res.rows[0];
    },
    async globalUsed() {
      const res = await pg.query<{ n: number }>("select coalesce(sum(used), 0)::int as n from token_usage where scope = 'global'");
      return res.rows[0].n;
    },
  };
}
