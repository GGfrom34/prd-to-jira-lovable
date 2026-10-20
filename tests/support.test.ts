import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadConfig } from "../supabase/functions/_shared/config.ts";
import { ApiError, clientIp, corsHeaders, readJson, routeOf } from "../supabase/functions/_shared/http.ts";
import { postSurveyRow } from "../supabase/functions/_shared/survey.ts";

const ENV = {
  ANTHROPIC_API_KEY: "sk-ant-x",
  VISITOR_SALT: "0123456789abcdef",
  ALLOWED_ORIGINS: "https://a.example, https://b.example",
  SUPABASE_URL: "https://proj.supabase.co/",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  SHEET_WEBHOOK_URL: "https://script.google.com/macros/s/X/exec",
  SHEET_SHARED_SECRET: "shh",
};

test("loadConfig applies defaults, trims origins and strips a trailing slash", () => {
  const c = loadConfig(ENV);
  assert.deepEqual(c.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(c.supabaseUrl, "https://proj.supabase.co");
  assert.equal(c.model, "claude-sonnet-5");
  assert.equal(c.version, "0.1");
  assert.equal(c.maxSessionsPerVisitor, 10);
  assert.deepEqual(c.caps, { global: 600_000, visitor: 120_000, session: 60_000 });
});

test("loadConfig prefers the new SUPABASE_SECRET_KEYS and falls back to the legacy key", () => {
  const { SUPABASE_SERVICE_ROLE_KEY: _legacy, ...base } = ENV;
  const both = { ...ENV, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_new" }) };
  assert.equal(loadConfig(both).serviceRoleKey, "sb_secret_new");
  assert.equal(loadConfig({ ...base, SUPABASE_SECRET_KEYS: JSON.stringify({ other: "sb_secret_other" }) }).serviceRoleKey, "sb_secret_other");
  assert.equal(loadConfig({ ...ENV, SUPABASE_SECRET_KEYS: "not json" }).serviceRoleKey, "svc");
  assert.equal(loadConfig(ENV).serviceRoleKey, "svc");
  assert.throws(() => loadConfig(base), /SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY/);
});

test("loadConfig fails closed, naming missing variables but never their values", () => {
  const { ANTHROPIC_API_KEY: _a, SHEET_SHARED_SECRET: _s, ...partial } = ENV;
  assert.throws(() => loadConfig(partial), /ANTHROPIC_API_KEY, SHEET_SHARED_SECRET/);
  assert.throws(() => loadConfig({ ...ENV, VISITOR_SALT: "short" }), /VISITOR_SALT/);
  assert.throws(() => loadConfig({ ...ENV, MAX_SESSIONS_PER_VISITOR_PER_DAY: "0" }), /MAX_SESSIONS/);
  assert.throws(() => loadConfig({ ...ENV, GLOBAL_DAILY_TOKEN_CAP: "lots" }), /GLOBAL_DAILY_TOKEN_CAP/);
  try {
    loadConfig({ ...ENV, VISITOR_SALT: "short" });
  } catch (e) {
    assert.equal((e as Error).message.includes("sk-ant-x"), false);
  }
});

test("routeOf handles the Supabase URL shape, a bare /api path and trailing slashes", () => {
  assert.equal(routeOf("/functions/v1/api/review"), "review");
  assert.equal(routeOf("/api/sign-off"), "sign-off");
  assert.equal(routeOf("/api/status/"), "status");
  assert.equal(routeOf("/api"), "");
  assert.equal(routeOf("/functions/v1/api"), "");
});

test("clientIp prefers Cloudflare's header, then falls back, then 'unknown'", () => {
  assert.equal(clientIp(new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9" })), "1.1.1.1");
  assert.equal(clientIp(new Headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9" })), "2.2.2.2");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" })), "3.3.3.3");
  assert.equal(clientIp(new Headers()), "unknown");
});

test("corsHeaders echoes only an exact listed origin", () => {
  assert.equal(corsHeaders("https://a.example", ["https://a.example"])["access-control-allow-origin"], "https://a.example");
  assert.equal(corsHeaders("https://a.example.evil.com", ["https://a.example"])["access-control-allow-origin"], undefined);
  assert.equal(corsHeaders(null, ["https://a.example"])["access-control-allow-origin"], undefined);
});

test("readJson rejects oversized, malformed and non-object bodies", async () => {
  const req = (body: string, headers: Record<string, string> = {}) => new Request("https://x", { method: "POST", body, headers });
  assert.deepEqual(await readJson(req('{"a":1}'), 100), { a: 1 });
  await assert.rejects(readJson(req("x".repeat(200)), 100), (e: ApiError) => e.code === "payload_too_large");
  await assert.rejects(readJson(req("{}", { "content-length": "999999" }), 100), (e: ApiError) => e.code === "payload_too_large");
  await assert.rejects(readJson(req("{nope"), 100), (e: ApiError) => e.code === "invalid_input");
  await assert.rejects(readJson(req("[1]"), 100), (e: ApiError) => e.code === "invalid_input");
  await assert.rejects(readJson(req("null"), 100), (e: ApiError) => e.code === "invalid_input");
});

test("postSurveyRow sends the secret in the body, not the URL, and requires ok:true", async () => {
  let seen: { url?: string; init?: RequestInit } = {};
  const reply = (status: number, body: unknown): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  await postSurveyRow("https://script.example/exec", "shh", ["id", "2026-10-20", "0.1", 1, 2, 3, 4, 5], reply(200, { ok: true }));
  assert.equal(seen.url, "https://script.example/exec");
  assert.equal(seen.url?.includes("shh"), false);
  assert.deepEqual(JSON.parse(String(seen.init?.body)), { secret: "shh", row: ["id", "2026-10-20", "0.1", 1, 2, 3, 4, 5] });

  await assert.rejects(postSurveyRow("https://s", "k", [], reply(200, { ok: false })), /rejected/);
  await assert.rejects(postSurveyRow("https://s", "k", [], reply(500, {})), /HTTP 500/);
});

// ---- Apps Script, run in a VM with the Google services stubbed ----

function loadAppsScript(secret: string | null) {
  const appended: unknown[][] = [];
  const sandbox: Record<string, unknown> = {
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => (n === "Responses" ? { appendRow: (r: unknown[]) => appended.push(r) } : null) }),
    },
  };
  vm.runInNewContext(readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8"), sandbox);
  const post = (payload: unknown) => {
    const out = (sandbox.doPost as (e: unknown) => { text: string })({ postData: { contents: typeof payload === "string" ? payload : JSON.stringify(payload) } });
    return JSON.parse(out.text).ok as boolean;
  };
  return { post, appended };
}

const GOOD_ROW = ["11111111-2222-3333-4444-555555555555", "2026-10-20", "0.1", 5, 4, 3, 2, 1];

test("Apps Script appends a valid row when the secret matches", () => {
  const { post, appended } = loadAppsScript("shh");
  assert.equal(post({ secret: "shh", row: GOOD_ROW }), true);
  // Compared as JSON because arrays created inside the VM have a different prototype.
  assert.equal(JSON.stringify(appended), JSON.stringify([GOOD_ROW]));
});

test("Apps Script refuses a wrong secret, a missing secret property and malformed JSON", () => {
  const wrong = loadAppsScript("shh");
  assert.equal(wrong.post({ secret: "nope", row: GOOD_ROW }), false);
  assert.equal(wrong.appended.length, 0);
  assert.equal(wrong.post("not json"), false);

  const unset = loadAppsScript(null);
  assert.equal(unset.post({ secret: "undefined", row: GOOD_ROW }), false);
  assert.equal(unset.post({ row: GOOD_ROW }), false);
});

test("Apps Script refuses any row that is not exactly an id, a date, a version and five 1-5 ratings", () => {
  const { post, appended } = loadAppsScript("shh");
  const bad: unknown[] = [
    [...GOOD_ROW, "extra"],
    GOOD_ROW.slice(0, 7),
    ["not-a-uuid", ...GOOD_ROW.slice(1)],
    [GOOD_ROW[0], "20 Oct 2026", ...GOOD_ROW.slice(2)],
    [GOOD_ROW[0], GOOD_ROW[1], "v<script>", ...GOOD_ROW.slice(3)],
    [...GOOD_ROW.slice(0, 3), 0, 4, 3, 2, 1],
    [...GOOD_ROW.slice(0, 3), 6, 4, 3, 2, 1],
    [...GOOD_ROW.slice(0, 3), 2.5, 4, 3, 2, 1],
    [...GOOD_ROW.slice(0, 3), "5", 4, 3, 2, 1],
    [...GOOD_ROW.slice(0, 3), "please call me on 555-0100", 4, 3, 2, 1],
    "free text instead of a row",
    null,
  ];
  for (const row of bad) assert.equal(post({ secret: "shh", row }), false, JSON.stringify(row));
  assert.equal(appended.length, 0);
});
