import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FEEDBACK_CHARS,
  MAX_PRD_CHARS,
  MESSAGES,
  checkInputCaps,
  estimateTokens,
  loadCaps,
  totalTokens,
  utcDay,
  visitorKey,
  withBudget,
  type BudgetStore,
  type Caps,
} from "../supabase/functions/_shared/guardrails.ts";
import { counters, freshDb, newSession, pgliteStore } from "./helpers/pglite-store.ts";

const DAY = "2026-10-20";
const CAPS: Caps = { global: 100_000, visitor: 100_000, session: 100_000 };
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });

async function setup() {
  const db = await freshDb();
  const store = pgliteStore(db);
  const session = await newSession(db, "v1");
  const run = <T>(estimate: number, call: () => Promise<{ value: T; usage: ReturnType<typeof usage> }>, s: BudgetStore = store) =>
    withBudget({ store: s, day: DAY, visitor: "v1", session, estimate, caps: CAPS, call });
  return { db, store, session, run };
}

test("loadCaps uses the defaults, accepts overrides and rejects bad values", () => {
  assert.deepEqual(loadCaps({}), { global: 600_000, visitor: 120_000, session: 60_000 });
  assert.deepEqual(
    loadCaps({ GLOBAL_DAILY_TOKEN_CAP: "1000", VISITOR_DAILY_TOKEN_CAP: "200", SESSION_TOKEN_CAP: "50" }),
    { global: 1000, visitor: 200, session: 50 },
  );
  for (const bad of ["abc", "0", "-5", "1.5"]) {
    assert.throws(() => loadCaps({ GLOBAL_DAILY_TOKEN_CAP: bad }), /GLOBAL_DAILY_TOKEN_CAP/);
  }
});

test("utcDay formats the UTC date, including near midnight", () => {
  assert.equal(utcDay(new Date("2026-10-20T23:59:59Z")), "2026-10-20");
  assert.equal(utcDay(new Date("2026-10-21T00:00:00Z")), "2026-10-21");
  assert.equal(utcDay(new Date("2026-10-20T23:30:00-05:00")), "2026-10-21");
});

test("visitorKey is stable, varies by day and salt, and does not contain the IP", async () => {
  const a = await visitorKey("203.0.113.7", "2026-10-20", "salt-a");
  assert.equal(a, await visitorKey("203.0.113.7", "2026-10-20", "salt-a"));
  assert.notEqual(a, await visitorKey("203.0.113.7", "2026-10-21", "salt-a"));
  assert.notEqual(a, await visitorKey("203.0.113.7", "2026-10-20", "salt-b"));
  assert.notEqual(a, await visitorKey("203.0.113.8", "2026-10-20", "salt-a"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes("203"));
});

test("estimateTokens counts the input as well as the output cap", () => {
  assert.equal(estimateTokens(0, 2500), 2500);
  assert.equal(estimateTokens(7000, 2500), 2000 + 2500);
  assert.equal(estimateTokens(1, 0), 1);
});

test("totalTokens includes cache tokens", () => {
  assert.equal(totalTokens(usage(100, 50)), 150);
  assert.equal(
    totalTokens({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }),
    165,
  );
  assert.equal(
    totalTokens({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null }),
    2,
  );
});

test("checkInputCaps enforces the PRD and feedback limits", () => {
  assert.equal(checkInputCaps({ prd: "x".repeat(MAX_PRD_CHARS) }), null);
  assert.match(checkInputCaps({ prd: "x".repeat(MAX_PRD_CHARS + 1) }) ?? "", /too long/);
  assert.equal(checkInputCaps({ feedback: "x".repeat(MAX_FEEDBACK_CHARS) }), null);
  assert.match(checkInputCaps({ feedback: "x".repeat(MAX_FEEDBACK_CHARS + 1) }) ?? "", /too long/);
  assert.equal(checkInputCaps({}), null);
});

test("withBudget settles to the real usage after a successful call", async () => {
  const { db, session, run } = await setup();
  const r = await run(5000, async () => ({ value: "hello", usage: usage(800, 700) }));
  assert.deepEqual(r, { ok: true, value: "hello", tokens: 1500 });
  assert.deepEqual(await counters(db, DAY, "v1", session), { global: 1500, visitor: 1500, session: 1500 });
});

test("withBudget does not call Claude when a cap denies the reservation", async () => {
  const { db, store, session } = await setup();
  let called = false;
  const r = await withBudget({
    store,
    day: DAY,
    visitor: "v1",
    session,
    estimate: 5000,
    caps: { global: 100, visitor: 100_000, session: 100_000 },
    call: async () => {
      called = true;
      return { value: "x", usage: usage(1, 1) };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(r, { ok: false, reason: "global_cap", message: MESSAGES.global_cap });
  assert.deepEqual(await counters(db, DAY, "v1", session), { global: 0, visitor: 0, session: 0 });
});

test("a call that throws stays charged at the full reserve", async () => {
  const { db, session, run } = await setup();
  const r = await run(5000, async () => {
    throw new Error("socket hang up");
  });
  assert.deepEqual(r, { ok: false, reason: "upstream_error", message: MESSAGES.upstream_error });
  assert.deepEqual(await counters(db, DAY, "v1", session), { global: 5000, visitor: 5000, session: 5000 });
});

test("rate-limit errors, including exhausted credit, map to the capacity message", async () => {
  const { run } = await setup();

  const named = new Error("429 rate_limit_error");
  named.name = "RateLimitError";
  const byName = await run(100, async () => {
    throw named;
  });
  assert.deepEqual(byName, { ok: false, reason: "rate_limited", message: MESSAGES.rate_limited });

  const byStatus = Object.assign(new Error("Too many requests"), { status: 429 });
  const r2 = await run(100, async () => {
    throw byStatus;
  });
  assert.equal(r2.ok === false && r2.reason, "rate_limited");
});

test("a failed settle still returns the reply the visitor already paid for", async () => {
  const { store, run } = await setup();
  const brokenSettle: BudgetStore = {
    reserve: (a) => store.reserve(a),
    settle: async () => {
      throw new Error("db down");
    },
  };
  const r = await run(5000, async () => ({ value: "kept", usage: usage(10, 10) }), brokenSettle);
  assert.deepEqual(r, { ok: true, value: "kept", tokens: 20 });
});

test("the error from a failed call is not logged, since it could carry the PRD text", async () => {
  const { run } = await setup();
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await run(100, async () => {
      throw new Error("PRD CONTENT SHOULD NEVER APPEAR");
    });
  } finally {
    console.error = original;
  }
  assert.equal(JSON.stringify(logged).includes("PRD CONTENT"), false);
});
