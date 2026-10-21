import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequest } from "../supabase/functions/_shared/agents.ts";
import { MESSAGES, estimateTokens } from "../supabase/functions/_shared/guardrails.ts";
import {
  DECISIONS,
  FINDINGS,
  IP,
  ORIGIN,
  PRD,
  PROPOSALS,
  SPLIT,
  USAGE,
  harness,
  testConfig,
  toolReply,
  type Harness,
} from "./helpers/api-harness.ts";

const goodLink = "https://acme.atlassian.net/jira/software/projects/ABC/boards/1";

async function reviewed(h: Harness) {
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return session;
}

test("golden path: every step in order, ending in one clean survey row", async () => {
  const h = await harness();

  const status = await h.call("GET", "status");
  assert.deepEqual([status.status, status.json.available], [200, true]);
  const survey = await h.call("GET", "survey");
  assert.equal(survey.json.questions.length, 5);

  const session = await h.session();

  const review = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(review.json.verdict, "needs_targeted_fixes");
  assert.deepEqual(review.json.findings.map((f: { id: string }) => f.id), ["f1", "f2"]);

  const improve = await h.call("POST", "improve", { session_id: session, prd: PRD, findings: review.json.findings });
  assert.equal(improve.json.proposals.length, 2);

  const fin = await h.call("POST", "finalize", {
    session_id: session,
    prd: PRD,
    findings: review.json.findings,
    proposals: improve.json.proposals,
    decisions: DECISIONS,
  });
  assert.equal(fin.json.prd_markdown, "# Improved PRD\n\nBetter.");

  assert.equal((await h.call("POST", "sign-off", { session_id: session })).status, 200);
  const split = await h.call("POST", "split", { session_id: session, prd: fin.json.prd_markdown });
  assert.equal(split.json.epic.title, "Saved searches");

  const revised = await h.call("POST", "revise-split", {
    session_id: session,
    prd: fin.json.prd_markdown,
    previous: { epic: split.json.epic, issues: split.json.issues },
    feedback: "Split the story in two",
  });
  assert.equal(revised.status, 200);

  assert.equal((await h.call("POST", "submit-link", { session_id: session, url: goodLink })).json.accepted, true);
  assert.equal((await h.call("POST", "submit-survey", { session_id: session, answers: [5, 4, 4, 3, 5] })).json.thanks, true);

  assert.equal((await h.stepOf(session)).step, "surveyed");
  assert.deepEqual(h.rows, [["11111111-2222-3333-4444-555555555555", "2026-10-20", "0.1", 5, 4, 4, 3, 5]]);

  const expected = Object.values(USAGE).reduce((s, u) => s + u.input_tokens + u.output_tokens, 0) + (USAGE.propose_breakdown.input_tokens + USAGE.propose_breakdown.output_tokens);
  assert.equal(await h.globalUsed(), expected);
});

test("the database never holds the visitor's IP or any PRD text", async () => {
  const h = await harness();
  await reviewed(h);
  const dump = JSON.stringify([
    (await h.pg.query("select * from sessions")).rows,
    (await h.pg.query("select * from token_usage")).rows,
    (await h.pg.query("select * from config")).rows,
  ]);
  assert.equal(dump.includes(IP), false);
  assert.equal(dump.includes("SENTINEL_PRD_TEXT"), false);
  assert.equal(dump.includes("retype"), false);
});

test("a PRD with no gaps can be signed off straight from the review", async () => {
  const h = await harness();
  const session = await reviewed(h);
  assert.equal((await h.call("POST", "sign-off", { session_id: session })).status, 200);
  assert.equal((await h.call("POST", "split", { session_id: session, prd: PRD })).status, 200);
});

test("out-of-order calls are refused with 409 and never reach Claude", async () => {
  const h = await harness();
  const session = await h.session();
  const body = { session_id: session, prd: PRD };
  const attempts: [string, Record<string, unknown>][] = [
    ["improve", { ...body, findings: FINDINGS }],
    ["finalize", { ...body, findings: FINDINGS, proposals: PROPOSALS, decisions: DECISIONS }],
    ["sign-off", { session_id: session }],
    ["split", body],
    ["revise-split", { ...body, previous: SPLIT, feedback: "x" }],
    ["submit-link", { session_id: session, url: goodLink }],
    ["submit-survey", { session_id: session, answers: [1, 1, 1, 1, 1] }],
  ];
  for (const [route, payload] of attempts) {
    const r = await h.call("POST", route, payload);
    assert.equal(r.status, 409, `${route} should be refused at step 'new'`);
    assert.equal(r.json.error.code, "wrong_step");
  }
  assert.equal(h.claudeCalls.length, 0);
  assert.equal(await h.globalUsed(), 0);
});

test("steps cannot be repeated: a second review, second revision and second survey are refused", async () => {
  const h = await harness();
  const session = await reviewed(h);
  assert.equal((await h.call("POST", "review", { session_id: session, prd: PRD })).status, 409);

  await h.setStep(session, "signed_off");
  await h.call("POST", "split", { session_id: session, prd: PRD });
  const revise = { session_id: session, prd: PRD, previous: SPLIT, feedback: "Change it" };
  assert.equal((await h.call("POST", "revise-split", revise)).status, 200);
  const second = await h.call("POST", "revise-split", revise);
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, "wrong_step");

  await h.call("POST", "submit-link", { session_id: session, url: goodLink });
  const answers = { session_id: session, answers: [3, 3, 3, 3, 3] };
  assert.equal((await h.call("POST", "submit-survey", answers)).status, 200);
  assert.equal((await h.call("POST", "submit-survey", answers)).status, 409);
  assert.equal(h.rows.length, 1);
});

test("a visitor can go straight from the split to the link without revising", async () => {
  const h = await harness();
  const session = await h.session();
  await h.setStep(session, "signed_off");
  await h.call("POST", "split", { session_id: session, prd: PRD });
  assert.equal((await h.call("POST", "submit-link", { session_id: session, url: goodLink })).status, 200);
});

test("two simultaneous reviews: one runs, one is told to wait, Claude is called once", async () => {
  const h = await harness({
    claude: async (p) => {
      await new Promise((r) => setTimeout(r, 30));
      return toolReply(p.tool_choice.name);
    },
  });
  const session = await h.session();
  const body = { session_id: session, prd: PRD };
  const [a, b] = await Promise.all([h.call("POST", "review", body), h.call("POST", "review", body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find((r) => r.status === 409)?.json.error.code, "busy");
  assert.equal(h.claudeCalls.length, 1);
});

test("each cap refuses with 429 and its own message, never calls Claude, and releases the step", async () => {
  const cases = [
    { caps: { global: 100, visitor: 1_000_000, session: 1_000_000 }, code: "global_cap" },
    { caps: { global: 1_000_000, visitor: 100, session: 1_000_000 }, code: "visitor_cap" },
    { caps: { global: 1_000_000, visitor: 1_000_000, session: 100 }, code: "session_cap" },
  ] as const;
  for (const c of cases) {
    const h = await harness({ config: { caps: c.caps } });
    const session = await h.session();
    const r = await h.call("POST", "review", { session_id: session, prd: PRD });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, c.code);
    assert.equal(r.json.error.message, MESSAGES[c.code]);
    assert.equal(h.claudeCalls.length, 0);
    assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });
  }
});

test("the kill switch answers 503 and status reports unavailable", async () => {
  const h = await harness();
  const session = await h.session();
  await h.pg.exec("update config set value = 'false' where key = 'enabled'");
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "disabled");
  assert.equal((await h.call("GET", "status")).json.available, false);
});

test("status goes unavailable when the day's capacity is nearly used", async () => {
  const h = await harness({ config: { caps: { global: 16_000, visitor: 1_000_000, session: 1_000_000 } } });
  assert.equal((await h.call("GET", "status")).json.available, true);
  const session = await h.session();
  await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal((await h.call("GET", "status")).json.available, false);
});

test("a failed Claude call returns 502, stays charged at the reserve, and can be retried", async () => {
  let fail = true;
  const h = await harness({
    claude: async (p) => {
      if (fail) throw new Error("socket hang up");
      return toolReply(p.tool_choice.name);
    },
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "upstream_error");
  assert.equal(r.json.error.detail, "Error", "the class is reported, the message is not");
  assert.equal(JSON.stringify(r.json).includes("socket hang up"), false);
  assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });

  const req = buildReviewRequest(PRD);
  assert.equal(await h.globalUsed(), estimateTokens(req.inputChars, req.params.max_tokens));

  fail = false;
  assert.equal((await h.call("POST", "review", { session_id: session, prd: PRD })).status, 200);
});

test("a rate-limited Claude call shows the capacity message with 429", async () => {
  const h = await harness({
    claude: async () => {
      throw Object.assign(new Error("429"), { name: "RateLimitError", status: 429 });
    },
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.message, MESSAGES.rate_limited);
});

test("model output that keeps failing validation is tried twice, then a 502 charged at its real usage for both", async () => {
  const h = await harness({ claude: async () => toolReply("report_findings", { verdict: "great" }) });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(h.claudeCalls.length, 2);
  assert.equal(r.status, 502);
  assert.match(r.json.error.detail, /^SchemaError: summary/);
  assert.ok(r.json.error.detail.endsWith("[sent: verdict=string(5) summary=string(1) findings=array(2) skipped_dimensions=array(0)]") || r.json.error.detail.includes("[sent: verdict=string(5)"), r.json.error.detail);
  assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });
  assert.equal(await h.globalUsed(), 2 * (USAGE.report_findings.input_tokens + USAGE.report_findings.output_tokens));
});

test("a malformed reply is retried once and the visitor just gets the good answer", async () => {
  let calls = 0;
  const h = await harness({
    claude: async () => {
      calls += 1;
      return calls === 1 ? toolReply("report_findings", { summary: "no verdict, no findings" }) : toolReply("report_findings");
    },
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(calls, 2);
  assert.equal(r.json.findings.length, 2);
  assert.deepEqual(await h.stepOf(session), { step: "reviewed", busy: false });
  assert.equal(await h.globalUsed(), 2 * (USAGE.report_findings.input_tokens + USAGE.report_findings.output_tokens), "both attempts are charged");
});

test("an API error is not retried, and a good reply is not called twice", async () => {
  let failing = 0;
  const h = await harness({
    claude: async () => {
      failing += 1;
      throw new Error("upstream down");
    },
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 502);
  assert.equal(failing, 1, "only malformed replies are retried");

  const ok = await harness();
  const s2 = await ok.session();
  await ok.call("POST", "review", { session_id: s2, prd: PRD });
  assert.equal(ok.claudeCalls.length, 1);
});

test("the retry is checked against the caps like any other call", async () => {
  const estimate = estimateTokens(buildReviewRequest(PRD).inputChars, buildReviewRequest(PRD).params.max_tokens);
  const h = await harness({
    config: { caps: { global: 1_000_000, visitor: 1_000_000, session: estimate + 100 } },
    claude: async () => toolReply("report_findings", { verdict: "great" }),
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "session_cap");
  assert.equal(h.claudeCalls.length, 1, "the second attempt was refused before reaching Claude");
  assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });
});

test("a list the model sends as JSON text, or an over-long field, is repaired and the call succeeds", async () => {
  const stringified = await harness({
    claude: async () => toolReply("report_findings", { verdict: "needs_targeted_fixes", summary: "x", findings: JSON.stringify(FINDINGS), skipped_dimensions: [] }),
  });
  const s1 = await stringified.session();
  const r1 = await stringified.call("POST", "review", { session_id: s1, prd: PRD });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.findings.length, 2);
  assert.deepEqual(await stringified.stepOf(s1), { step: "reviewed", busy: false });

  const overlong = await harness({
    claude: async () => toolReply("report_findings", { verdict: "ready", summary: "x".repeat(500), findings: [], skipped_dimensions: [] }),
  });
  const s2 = await overlong.session();
  const r2 = await overlong.call("POST", "review", { session_id: s2, prd: PRD });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.summary.length, 300);
});

test("labels the model invents are mapped to the nearest valid one and the call succeeds", async () => {
  const h = await harness({
    claude: async () =>
      toolReply("report_findings", {
        verdict: "Needs significant rework",
        summary: "x",
        findings: [{ dimension: "trust_and_safety", severity: "Critical", section: "Scope", quote: null, issue: "No sitter verification." }],
        skipped_dimensions: [],
      }),
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.verdict, "needs_significant_rework");
  assert.deepEqual([r.json.findings[0].dimension, r.json.findings[0].severity], ["non_functional", "blocker"]);
});

test("an unrepairable list reports where the JSON broke, as numbers only", async () => {
  const bad = '[{"issue": "a list that is cut off SENTINEL_PRD_TEXT';
  const h = await harness({
    claude: async () => toolReply("report_findings", { verdict: "ready", summary: "x", findings: bad, skipped_dimensions: [] }),
  });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 502);
  assert.match(r.json.error.detail, /findings=string\(\d+,json-error@\d+:code-?\d+\)/);
  assert.equal(JSON.stringify(r.json).includes("SENTINEL"), false);
});

test("a truncated model response is a 502 and the step stays retryable", async () => {
  const h = await harness({ claude: async () => ({ ...toolReply("report_findings"), stop_reason: "max_tokens" }) });
  const session = await h.session();
  const r = await h.call("POST", "review", { session_id: session, prd: PRD });
  assert.equal(r.status, 502);
  assert.ok(r.json.error.detail.startsWith("AgentOutputError: Response was cut off (500 output tokens; findings:2") && r.json.error.detail.includes("findings=array(2)"), r.json.error.detail);
  assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });
});

test("bad input is refused with 4xx before any token is reserved", async () => {
  const h = await harness();
  const session = await h.session();
  const cases: [string, unknown, number][] = [
    ["no PRD", { session_id: session }, 400],
    ["blank PRD", { session_id: session, prd: "   " }, 400],
    ["PRD over 12,000 characters", { session_id: session, prd: "x".repeat(12_001) }, 400],
    ["PRD not a string", { session_id: session, prd: { a: 1 } }, 400],
    ["session id not a uuid", { session_id: "1; drop table sessions", prd: PRD }, 400],
    ["no session id", { prd: PRD }, 400],
    ["not JSON", "{nope", 400],
    ["JSON array", "[1,2]", 400],
    ["body over the size limit", { session_id: session, prd: "x".repeat(101_000) }, 413],
  ];
  for (const [name, body, status] of cases) {
    const r = await h.call("POST", "review", body);
    assert.equal(r.status, status, name);
  }
  assert.equal(h.claudeCalls.length, 0);
  assert.equal(await h.globalUsed(), 0);
  assert.deepEqual(await h.stepOf(session), { step: "new", busy: false });
});

test("unknown session ids are a 404", async () => {
  const h = await harness();
  const r = await h.call("POST", "review", { session_id: "00000000-0000-4000-8000-000000000000", prd: PRD });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "no_session");
});

test("tampered findings are re-validated and refused without echoing the visitor's text", async () => {
  const h = await harness();
  const session = await reviewed(h);
  const bad = [{ ...FINDINGS[0], severity: "CRITICAL_SECRET_WORD" }];
  const r = await h.call("POST", "improve", { session_id: session, prd: PRD, findings: bad });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /severity/);
  assert.equal(JSON.stringify(r.json).includes("CRITICAL_SECRET_WORD"), false);
  assert.equal(h.claudeCalls.length, 1, "only the earlier review reached Claude");
});

test("finalize validates decisions and builds the changes from the PM's choices", async () => {
  const h = await harness();
  const session = await h.session();
  await h.setStep(session, "improved");
  const base = { session_id: session, prd: PRD, findings: FINDINGS, proposals: PROPOSALS };

  const refused: [string, unknown][] = [
    ["unknown finding id", [{ finding_id: "f9", action: "accept" }]],
    ["edit without text", [{ finding_id: "f1", action: "edit" }]],
    ["no decisions", []],
    ["bad action", [{ finding_id: "f1", action: "delete" }]],
    ["duplicate ids", [{ finding_id: "f1", action: "accept" }, { finding_id: "f1", action: "defer" }]],
  ];
  for (const [name, decisions] of refused) {
    const r = await h.call("POST", "finalize", { ...base, decisions });
    assert.equal(r.status, 400, name);
  }
  assert.equal(h.claudeCalls.length, 0);

  const ok = await h.call("POST", "finalize", { ...base, decisions: DECISIONS });
  assert.equal(ok.status, 200);
  const sent = h.claudeCalls[0].messages[0].content;
  assert.ok(sent.includes("My own 35% target"), "an edit uses the PM's own text");
  assert.ok(sent.includes("Ships in one PR."), "an accept uses the proposal");
  assert.equal(sent.includes("Add a [20%] target."), false, "an overridden proposal is not sent");
});

test("revise-split needs sensible feedback and a valid previous breakdown", async () => {
  const h = await harness();
  const session = await h.session();
  await h.setStep(session, "split_proposed");
  const base = { session_id: session, prd: PRD, previous: SPLIT };

  for (const feedback of [undefined, "", "   ", "x".repeat(501), 42]) {
    assert.equal((await h.call("POST", "revise-split", { ...base, feedback })).status, 400, String(feedback));
  }
  const badPrev = { ...SPLIT, issues: [{ ...SPLIT.issues[0], type: "subtask" }] };
  assert.equal((await h.call("POST", "revise-split", { ...base, previous: badPrev, feedback: "ok" })).status, 400);
  assert.equal(h.claudeCalls.length, 0);

  const ok = await h.call("POST", "revise-split", { ...base, feedback: "Merge the two stories" });
  assert.equal(ok.status, 200);
  assert.ok(h.claudeCalls[0].messages[0].content.includes("Merge the two stories"));
});

test("only real Jira Cloud project links are accepted, and a bad link leaves the step unchanged", async () => {
  const h = await harness();
  const session = await h.session();
  await h.setStep(session, "split_proposed");
  const bad = [
    "http://acme.atlassian.net/jira/software/projects/ABC",
    "https://evil.example.com/jira/software/projects/ABC",
    "https://acme.atlassian.net.evil.com/jira/software/projects/ABC",
    "https://user:pw@acme.atlassian.net/jira/software/projects/ABC",
    "https://acme.atlassian.net:8443/jira/software/projects/ABC",
    "https://acme.atlassian.net/wiki/spaces/X",
    "javascript:alert(1)",
    "not a url",
    "https://acme.atlassian.net/jira/" + "a".repeat(300),
    12345,
    undefined,
  ];
  for (const url of bad) {
    const r = await h.call("POST", "submit-link", { session_id: session, url });
    assert.equal(r.status, 400, String(url));
  }
  assert.deepEqual(await h.stepOf(session), { step: "split_proposed", busy: false });

  for (const url of [goodLink, "https://acme.atlassian.net/browse/ABC-12"]) {
    await h.setStep(session, "split_proposed");
    assert.equal((await h.call("POST", "submit-link", { session_id: session, url })).status, 200, url);
  }
});

test("the survey accepts exactly five whole-number ratings from 1 to 5 and nothing else", async () => {
  const h = await harness();
  const session = await h.session();
  await h.setStep(session, "link_submitted");
  const bad: [string, Record<string, unknown>][] = [
    ["four answers", { answers: [1, 2, 3, 4] }],
    ["six answers", { answers: [1, 2, 3, 4, 5, 5] }],
    ["zero", { answers: [0, 1, 1, 1, 1] }],
    ["six", { answers: [6, 1, 1, 1, 1] }],
    ["fractional", { answers: [3.5, 1, 1, 1, 1] }],
    ["string rating", { answers: ["5", 1, 1, 1, 1] }],
    ["free-text field", { answers: [1, 1, 1, 1, 1], comment: "please call me" }],
    ["answers missing", {}],
  ];
  for (const [name, extra] of bad) {
    const r = await h.call("POST", "submit-survey", { session_id: session, ...extra });
    assert.equal(r.status, 400, name);
  }
  assert.equal(h.rows.length, 0);
  assert.deepEqual(await h.stepOf(session), { step: "link_submitted", busy: false });
  assert.equal((await h.call("POST", "submit-survey", { session_id: session, answers: [1, 2, 3, 4, 5] })).status, 200);
  assert.equal(h.rows.length, 1);
});

test("a failed sheet write is a 502, keeps the step, and a retry writes exactly one row", async () => {
  let fail = true;
  const rows: unknown[] = [];
  const h = await harness({
    appendSurveyRow: async (row) => {
      if (fail) throw new Error("sheet down");
      rows.push(row);
    },
  });
  const session = await h.session();
  await h.setStep(session, "link_submitted");
  const body = { session_id: session, answers: [4, 4, 4, 4, 4] };

  const r = await h.call("POST", "submit-survey", body);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "sheet_error");
  assert.deepEqual(await h.stepOf(session), { step: "link_submitted", busy: false });

  fail = false;
  assert.equal((await h.call("POST", "submit-survey", body)).status, 200);
  assert.equal(rows.length, 1);
});

test("the per-visitor session limit answers 429", async () => {
  const h = await harness({ config: { maxSessionsPerVisitor: 2 } });
  assert.equal((await h.call("POST", "session")).status, 200);
  assert.equal((await h.call("POST", "session")).status, 200);
  const third = await h.call("POST", "session");
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, "too_many_sessions");
  assert.equal((await h.call("POST", "session", undefined, { "cf-connecting-ip": "198.51.100.1" })).status, 200);
});

test("different visitors are counted separately and neither IP is stored", async () => {
  const h = await harness();
  const a = await h.session();
  const bRes = await h.call("POST", "session", undefined, { "cf-connecting-ip": "198.51.100.77" });
  await h.call("POST", "review", { session_id: a, prd: PRD });
  await h.call("POST", "review", { session_id: bRes.json.session_id, prd: PRD }, { "cf-connecting-ip": "198.51.100.77" });
  const keys = await h.pg.query<{ key: string }>("select key from token_usage where scope = 'visitor'");
  assert.equal(keys.rows.length, 2);
  for (const k of keys.rows) assert.match(k.key, /^[0-9a-f]{64}$/);
});

test("CORS: only listed origins are echoed, on success, errors and preflight", async () => {
  const h = await harness();
  const ok = await h.call("GET", "status");
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);

  const err = await h.call("POST", "review", {});
  assert.equal(err.headers.get("access-control-allow-origin"), ORIGIN);

  const other = await h.call("GET", "status", undefined, { origin: "https://evil.example" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);

  const pre = await h.call("OPTIONS", "review");
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
  const preOther = await h.call("OPTIONS", "review", undefined, { origin: "https://evil.example" });
  assert.equal(preOther.headers.get("access-control-allow-origin"), null);
});

test("routing: unknown routes 404, wrong methods 405, and both URL shapes work", async () => {
  const h = await harness();
  assert.equal((await h.call("GET", "nope")).status, 404);
  assert.equal((await h.call("GET", "review")).status, 405);
  assert.equal((await h.call("POST", "status", {})).status, 405);
  assert.equal((await h.call("DELETE", "status")).status, 405);

  const bare = await (await import("../supabase/functions/_shared/api.ts")).handle(
    new Request("https://proj.supabase.co/api/status", { headers: { origin: ORIGIN } }),
    h.deps,
  );
  assert.equal(bare.status, 200);
});

test("logs never contain the PRD, the feedback, the API keys or the visitor's IP", async () => {
  const logged: string[] = [];
  const originals = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
    console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }
  try {
    const h = await harness({
      claude: async () => {
        throw new Error("upstream said: SENTINEL_PRD_TEXT sk-ant-TEST-KEY-123");
      },
      dbOverride: (db) => ({
        ...db,
        capacityAvailable: async () => {
          throw new Error("db said: SENTINEL_PRD_TEXT service-role-TEST-KEY");
        },
      }),
    });
    const session = await h.session();
    const failed = await h.call("POST", "review", { session_id: session, prd: PRD });
    assert.equal(failed.status, 502);
    const crashed = await h.call("GET", "status");
    assert.equal(crashed.status, 500);
    assert.equal(JSON.stringify(crashed.json).includes("SENTINEL"), false);
  } finally {
    Object.assign(console, originals);
  }
  const all = logged.join("\n");
  for (const secret of ["SENTINEL_PRD_TEXT", "sk-ant-TEST-KEY-123", "service-role-TEST-KEY", IP]) {
    assert.equal(all.includes(secret), false, `logs leaked ${secret}`);
  }
});

test("no response ever contains a configured secret", async () => {
  const h = await harness();
  const session = await h.session();
  const responses = [
    await h.call("GET", "status"),
    await h.call("POST", "review", { session_id: session, prd: PRD }),
    await h.call("POST", "review", {}),
    await h.call("GET", "nope"),
  ];
  const cfg = testConfig();
  for (const r of responses) {
    const text = JSON.stringify(r.json);
    for (const secret of [cfg.anthropicKey, cfg.serviceRoleKey, cfg.sheetSecret, cfg.visitorSalt]) {
      assert.equal(text.includes(secret), false);
    }
  }
});
