// Pure logic with no Deno- or Node-specific APIs, so it runs in Edge Functions
// and in the Node test runner alike. All database access goes through BudgetStore.

export const MAX_PRD_CHARS = 12_000;
export const MAX_FEEDBACK_CHARS = 500;
const CHARS_PER_TOKEN = 3.5;

export type Caps = { global: number; visitor: number; session: number };

const DEFAULT_CAPS: Caps = { global: 600_000, visitor: 120_000, session: 60_000 };

function parseCap(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

// Throws on a malformed value so a typo fails closed instead of silently
// falling back to a different cap.
export function loadCaps(env: Record<string, string | undefined>): Caps {
  return {
    global: parseCap(env.GLOBAL_DAILY_TOKEN_CAP, DEFAULT_CAPS.global, "GLOBAL_DAILY_TOKEN_CAP"),
    visitor: parseCap(env.VISITOR_DAILY_TOKEN_CAP, DEFAULT_CAPS.visitor, "VISITOR_DAILY_TOKEN_CAP"),
    session: parseCap(env.SESSION_TOKEN_CAP, DEFAULT_CAPS.session, "SESSION_TOKEN_CAP"),
  };
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// The salt must be a secret that is rotated daily by the caller; the day is
// also mixed in so the same IP maps to a different key each UTC day.
export async function visitorKey(ip: string, day: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${day}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function estimateTokens(inputChars: number, maxTokens: number): number {
  return Math.ceil(inputChars / CHARS_PER_TOKEN) + maxTokens;
}

export function checkInputCaps(input: { prd?: string; feedback?: string }): string | null {
  if (input.prd !== undefined && input.prd.length > MAX_PRD_CHARS) {
    return `Your PRD is too long. Please keep it under ${MAX_PRD_CHARS.toLocaleString("en-US")} characters.`;
  }
  if (input.feedback !== undefined && input.feedback.length > MAX_FEEDBACK_CHARS) {
    return `Your feedback is too long. Please keep it under ${MAX_FEEDBACK_CHARS} characters.`;
  }
  return null;
}

export type DenyReason = "disabled" | "global_cap" | "visitor_cap" | "session_cap" | "no_session";
export type FailReason = DenyReason | "rate_limited" | "upstream_error";

export const MESSAGES: Record<FailReason, string> = {
  global_cap: "Today's capacity for this prototype has been used up. Please come back after 00:00 UTC.",
  rate_limited: "Today's capacity for this prototype has been used up. Please come back after 00:00 UTC.",
  visitor_cap: "You've reached today's usage allowance. Please come back after 00:00 UTC.",
  session_cap: "This session has reached its usage limit. Please start a new session.",
  disabled: "This prototype is temporarily unavailable.",
  no_session: "Your session has expired. Please start again.",
  upstream_error: "Something went wrong generating a response. Please try again.",
};

export type ReserveArgs = {
  day: string;
  visitor: string;
  session: string;
  estimate: number;
  caps: Caps;
};

export type SettleArgs = {
  day: string;
  visitor: string;
  session: string;
  estimate: number;
  actual: number;
};

export interface BudgetStore {
  reserve(args: ReserveArgs): Promise<"ok" | DenyReason>;
  settle(args: SettleArgs): Promise<void>;
}

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

// Cache reads are billed cheaper, but counting them at face value keeps the
// cap conservative.
export function totalTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export type GuardedResult<T> =
  | { ok: true; value: T; tokens: number }
  | { ok: false; reason: FailReason; message: string };

function isRateLimit(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "RateLimitError" || (err as { status?: number }).status === 429;
}

function fail<T>(reason: FailReason): GuardedResult<T> {
  return { ok: false, reason, message: MESSAGES[reason] };
}

export type WithBudgetOptions<T> = {
  store: BudgetStore;
  day: string;
  visitor: string;
  session: string;
  estimate: number;
  caps: Caps;
  call: () => Promise<{ value: T; usage: Usage }>;
};

// Reserve, call, settle. A call that throws stays charged at the full reserve
// (we cannot know what was spent). The error is never logged with its body,
// because the request carried the visitor's PRD text.
export async function withBudget<T>(opts: WithBudgetOptions<T>): Promise<GuardedResult<T>> {
  const { store, day, visitor, session, estimate, caps } = opts;

  const reserved = await store.reserve({ day, visitor, session, estimate, caps });
  if (reserved !== "ok") return fail(reserved);

  let outcome: { value: T; usage: Usage };
  try {
    outcome = await opts.call();
  } catch (err) {
    return fail(isRateLimit(err) ? "rate_limited" : "upstream_error");
  }

  const tokens = totalTokens(outcome.usage);
  try {
    await store.settle({ day, visitor, session, estimate, actual: tokens });
  } catch {
    // The reserve stays in place, which over-charges if anything. Keep the
    // reply the visitor already paid for.
    console.error("settle_failed");
  }
  return { ok: true, value: outcome.value, tokens };
}
