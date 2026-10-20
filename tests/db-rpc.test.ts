import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcDb } from "../supabase/functions/_shared/db.ts";
import { freshDb } from "./helpers/pglite-store.ts";

type Call = { fn: string; body: Record<string, unknown>; headers: Record<string, string> };

function recordingFetch(calls: Call[], reply: (fn: string) => { status?: number; body?: string }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = String(url).split("/rest/v1/rpc/")[1];
    calls.push({ fn, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const r = reply(fn);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : (r.body ?? "null"), { status });
  }) as typeof fetch;
}

const CAPS = { global: 10, visitor: 10, session: 10 };

async function exerciseAll(calls: Call[]) {
  const db = rpcDb("https://proj.supabase.co", "service-key", recordingFetch(calls, (fn) => ({
    body: { start_session: '"11111111-1111-1111-1111-111111111111"', begin_step: '"ok"', reserve_tokens: '"ok"', capacity_available: "true" }[fn],
  })));
  assert.equal(await db.startSession("v", 5), "11111111-1111-1111-1111-111111111111");
  assert.equal(await db.beginStep("s", ["new", "reviewed"]), "ok");
  await db.finishStep("s", "reviewed");
  await db.abortStep("s");
  assert.equal(await db.capacityAvailable("2026-10-20", 100, 5), true);
  assert.equal(await db.reserve({ day: "2026-10-20", visitor: "v", session: "s", estimate: 5, caps: CAPS }), "ok");
  await db.settle({ day: "2026-10-20", visitor: "v", session: "s", estimate: 5, actual: 3 });
}

test("rpcDb calls each SQL function through PostgREST with the service key", async () => {
  const calls: Call[] = [];
  await exerciseAll(calls);
  assert.deepEqual(
    calls.map((c) => c.fn),
    ["start_session", "begin_step", "finish_step", "abort_step", "capacity_available", "reserve_tokens", "settle_tokens"],
  );
  for (const c of calls) assert.equal(c.headers.apikey, "service-key");
});

test("a legacy JWT key is sent as apikey and Bearer, a new-style sb_secret_ key as apikey only", async () => {
  for (const [key, bearer] of [["eyJhbGciOi.legacy.jwt", true], ["sb_secret_abc123", false]] as const) {
    const calls: Call[] = [];
    await rpcDb("https://proj.supabase.co", key, recordingFetch(calls, () => ({}))).abortStep("s");
    assert.equal(calls[0].headers.apikey, key);
    assert.equal(calls[0].headers.authorization, bearer ? `Bearer ${key}` : undefined, key);
  }
});

test("rpcDb argument names match the SQL parameter names in the migration", async () => {
  const calls: Call[] = [];
  await exerciseAll(calls);
  const pg = await freshDb();
  for (const c of calls) {
    const res = await pg.query<{ names: string[]; defaults: number }>(
      "select proargnames as names, pronargdefaults as defaults from pg_proc where proname = $1",
      [c.fn],
    );
    assert.equal(res.rows.length, 1, `${c.fn} should exist exactly once`);
    const { names, defaults } = res.rows[0];
    const required = names.slice(0, names.length - defaults);
    const sent = Object.keys(c.body);
    for (const r of required) assert.ok(sent.includes(r), `${c.fn}: missing required argument ${r}`);
    for (const s of sent) assert.ok(names.includes(s), `${c.fn}: sent unknown argument ${s}`);
  }
});

test("rpcDb treats an empty response as null and surfaces HTTP errors without the body", async () => {
  const db = rpcDb("https://proj.supabase.co", "k", recordingFetch([], () => ({ status: 204, body: "" })));
  assert.equal(await db.startSession("v", 1), null);

  const failing = rpcDb("https://proj.supabase.co", "k", recordingFetch([], () => ({ status: 500, body: '{"message":"SECRET DETAIL"}' })));
  await assert.rejects(failing.abortStep("s"), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes("SECRET"));
});
