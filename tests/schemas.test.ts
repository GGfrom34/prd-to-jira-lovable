import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSIONS,
  FINALIZE_TOOL,
  IMPROVE_TOOL,
  REVIEW_TOOL,
  SPLIT_TOOL,
  SchemaError,
  parseDecisions,
  parseFinalPrd,
  parseImprovement,
  parseReview,
  parseSplit,
  ISSUE_TYPES,
  SEVERITIES,
  VERDICTS,
  coerceEnum,
  normaliseToSchema,
  parseFindings,
  withIds,
} from "../supabase/functions/_shared/schemas.ts";

const finding = {
  dimension: "success_metrics",
  severity: "blocker",
  section: "Goals",
  quote: "Let a visitor save",
  issue: "No measurable target.",
};
const review = {
  verdict: "needs_targeted_fixes",
  summary: "Solid scope, missing a success metric.",
  findings: [finding],
  skipped_dimensions: [{ dimension: "rollout_rollback", reason: "Small internal tool." }],
  strengths: "Clear problem statement.",
};
const split = {
  epic: { title: "Saved searches", description: "Summary.\nSource: PRD" },
  issues: [{ type: "story", title: "Save a profile", description: "Save it.", acceptance_criteria: ["Button after result"] }],
};

test("parseReview accepts a valid review and trims strings", () => {
  const r = parseReview({ ...review, summary: "  padded  " });
  assert.equal(r.summary, "padded");
  assert.equal(r.findings[0].quote, "Let a visitor save");
});

test("parseReview treats a missing quote, strengths and skipped list as empty", () => {
  const { quote: _q, ...noQuote } = finding;
  const r = parseReview({ verdict: "ready", summary: "Fine.", findings: [noQuote] });
  assert.equal(r.findings[0].quote, null);
  assert.equal(r.strengths, null);
  assert.deepEqual(r.skipped_dimensions, []);
});

test("parseReview rejects bad enums, empty and over-long strings, and too many findings", () => {
  assert.throws(() => parseReview({ ...review, verdict: "great" }), /verdict/);
  assert.throws(() => parseReview({ ...review, findings: [{ ...finding, severity: "critical" }] }), /severity/);
  assert.throws(() => parseReview({ ...review, findings: [{ ...finding, dimension: "other" }] }), /dimension/);
  assert.throws(() => parseReview({ ...review, summary: "  " }), /empty/);
  assert.throws(() => parseReview({ ...review, summary: "x".repeat(301) }), /at most 300/);
  assert.throws(() => parseReview({ ...review, findings: Array(21).fill(finding) }), /at most 20/);
  assert.throws(() => parseReview("nope"), SchemaError);
  assert.throws(() => parseReview(null), SchemaError);
});

test("withIds numbers findings from f1 in order", () => {
  const ids = withIds(parseReview(review).findings.concat(parseReview(review).findings));
  assert.deepEqual(ids.map((f) => f.id), ["f1", "f2"]);
});

test("parseImprovement validates ids, rejects unknown and duplicate ones", () => {
  const ok = { proposals: [{ finding_id: "f1", question: "What number?", before: null, proposed_text: "Add [20%] target." }] };
  assert.equal(parseImprovement(ok, new Set(["f1"]))[0].before, null);
  assert.throws(() => parseImprovement(ok, new Set(["f2"])), /unknown finding id/);
  const dup = { proposals: [ok.proposals[0], ok.proposals[0]] };
  assert.throws(() => parseImprovement(dup, new Set(["f1"])), /duplicate/);
  assert.throws(() => parseImprovement({ proposals: [{ ...ok.proposals[0], proposed_text: "" }] }, new Set(["f1"])), /empty/);
});

test("parseDecisions requires text only for edits and ignores it otherwise", () => {
  const ids = new Set(["f1", "f2", "f3"]);
  const out = parseDecisions(
    [
      { finding_id: "f1", action: "accept", text: "ignored" },
      { finding_id: "f2", action: "edit", text: "My own wording" },
      { finding_id: "f3", action: "defer" },
    ],
    ids,
  );
  assert.deepEqual(out.map((d) => d.text), [null, "My own wording", null]);
  assert.throws(() => parseDecisions([{ finding_id: "f1", action: "edit" }], ids), /expected a string/);
});

test("parseDecisions is a trust boundary: unknown ids, bad actions, duplicates and floods fail", () => {
  const ids = new Set(["f1"]);
  assert.throws(() => parseDecisions([{ finding_id: "f9", action: "accept" }], ids), /unknown finding id/);
  assert.throws(() => parseDecisions([{ finding_id: "f1", action: "delete" }], ids), /action/);
  assert.throws(
    () => parseDecisions([{ finding_id: "f1", action: "accept" }, { finding_id: "f1", action: "defer" }], ids),
    /duplicate/,
  );
  assert.throws(() => parseDecisions(Array(21).fill({ finding_id: "f1", action: "accept" }), ids), /at most 20/);
  assert.throws(() => parseDecisions({ finding_id: "f1" }, ids), /expected an array/);
  assert.throws(() => parseDecisions([{ finding_id: "f1", action: "edit", text: "x".repeat(2501) }], ids), /at most 2500/);
});

test("parseFinalPrd needs non-empty markdown within the size limit", () => {
  assert.equal(parseFinalPrd({ prd_markdown: "# PRD" }).prd_markdown, "# PRD");
  assert.throws(() => parseFinalPrd({ prd_markdown: "" }), /empty/);
  assert.throws(() => parseFinalPrd({ prd_markdown: "x".repeat(20_001) }), /at most 20000/);
});

test("parseSplit accepts story and task, rejects sub-tasks and an empty issue list", () => {
  assert.equal(parseSplit(split).issues[0].type, "story");
  assert.throws(() => parseSplit({ ...split, issues: [{ ...split.issues[0], type: "subtask" }] }), /type/);
  assert.throws(() => parseSplit({ ...split, issues: [] }), /at least 1/);
  assert.throws(() => parseSplit({ ...split, issues: Array(16).fill(split.issues[0]) }), /at most 15/);
  assert.throws(() => parseSplit({ ...split, epic: { title: "", description: "x" } }), /empty/);
});

test("parseSplit treats missing acceptance criteria as an empty list", () => {
  const { acceptance_criteria: _a, ...noAc } = split.issues[0];
  assert.deepEqual(parseSplit({ ...split, issues: [noAc] }).issues[0].acceptance_criteria, []);
});

test("normaliseToSchema decodes a list the model sent as JSON text (the production failure)", () => {
  const sent = { ...review, findings: JSON.stringify([finding]) };
  assert.throws(() => parseReview(sent), /findings: expected an array/);
  const fixed = parseReview(normaliseToSchema(sent, REVIEW_TOOL.input_schema));
  assert.equal(fixed.findings.length, 1);
  assert.equal(fixed.findings[0].dimension, "success_metrics");
});

test("normaliseToSchema decodes a whole input sent as JSON text, and nested lists too", () => {
  const whole = JSON.stringify({ ...review, skipped_dimensions: JSON.stringify([{ dimension: "scope", reason: "n/a" }]) });
  const fixed = parseReview(normaliseToSchema(whole, REVIEW_TOOL.input_schema));
  assert.equal(fixed.skipped_dimensions[0].dimension, "scope");
});

test("normaliseToSchema clips over-long strings and lists instead of failing a paid reply", () => {
  const long = {
    ...review,
    summary: "s".repeat(400),
    findings: Array.from({ length: 25 }, () => ({ ...finding, issue: "i".repeat(900), quote: "q".repeat(500) })),
  };
  const fixed = parseReview(normaliseToSchema(long, REVIEW_TOOL.input_schema));
  assert.equal(fixed.summary.length, 300);
  assert.ok(fixed.summary.endsWith("…"));
  assert.equal(fixed.findings.length, 20);
  assert.equal(fixed.findings[0].issue.length, 700);
  assert.equal(fixed.findings[0].quote?.length, 400);
});

test("normaliseToSchema leaves valid input, nulls and string fields alone", () => {
  assert.deepEqual(normaliseToSchema(review, REVIEW_TOOL.input_schema), review);
  const nullQuote = { ...review, findings: [{ ...finding, quote: null }] };
  assert.deepEqual(normaliseToSchema(nullQuote, REVIEW_TOOL.input_schema), nullQuote);
  const md = { prd_markdown: '["this is markdown, not a list"]' };
  assert.deepEqual(normaliseToSchema(md, FINALIZE_TOOL.input_schema), md);
});

test("normaliseToSchema cannot rescue text that is not valid JSON, so validation still fails", () => {
  const broken = { ...review, findings: "not json at all" };
  assert.throws(() => parseReview(normaliseToSchema(broken, REVIEW_TOOL.input_schema)), /findings: expected an array/);
});

test("coerceEnum accepts exact and differently formatted labels", () => {
  assert.equal(coerceEnum("needs_significant_rework", [...VERDICTS]), "needs_significant_rework");
  assert.equal(coerceEnum("Needs significant rework", [...VERDICTS]), "needs_significant_rework");
  assert.equal(coerceEnum("NEEDS-TARGETED-FIXES", [...VERDICTS]), "needs_targeted_fixes");
  assert.equal(coerceEnum("Blocker", [...SEVERITIES]), "blocker");
  assert.equal(coerceEnum("Success Metrics", [...DIMENSIONS]), "success_metrics");
});

test("coerceEnum maps invented labels to the nearest valid one, with a sensible fallback", () => {
  assert.equal(coerceEnum("trust_and_safety", [...DIMENSIONS]), "non_functional");
  assert.equal(coerceEnum("security", [...DIMENSIONS]), "non_functional");
  assert.equal(coerceEnum("payments_and_cancellation", [...DIMENSIONS]), "edge_cases");
  assert.equal(coerceEnum("something unrelated", [...DIMENSIONS]), "dependencies_risks_questions");
  assert.equal(coerceEnum("critical", [...SEVERITIES]), "blocker");
  assert.equal(coerceEnum("minor", [...SEVERITIES]), "nice_to_have");
  assert.equal(coerceEnum("subtask", [...ISSUE_TYPES]), "task");
  assert.equal(coerceEnum("partially ready", [...VERDICTS]), "ready");
  assert.equal(coerceEnum("unknown thing", [...VERDICTS]), "needs_targeted_fixes");
  assert.equal(coerceEnum("x", ["a", "b"]), null, "an enum with no mapping table is left alone");
});

test("normaliseToSchema repairs invented labels in a model review, so it validates", () => {
  const sent = {
    ...review,
    verdict: "Needs significant rework",
    findings: [{ ...finding, dimension: "trust_and_safety", severity: "Critical" }],
  };
  assert.throws(() => parseReview(sent), /verdict/);
  const fixed = parseReview(normaliseToSchema(sent, REVIEW_TOOL.input_schema));
  assert.equal(fixed.verdict, "needs_significant_rework");
  assert.equal(fixed.findings[0].dimension, "non_functional");
  assert.equal(fixed.findings[0].severity, "blocker");
});

test("visitor-supplied labels are still validated strictly", () => {
  assert.throws(() => parseDecisions([{ finding_id: "f1", action: "Accept it" }], new Set(["f1"])), /action/);
  assert.throws(() => parseFindings([{ ...finding, severity: "Critical" }]), /severity/);
});

test("the tool JSON schemas stay in step with the validators", () => {
  const props = REVIEW_TOOL.input_schema.properties;
  assert.deepEqual(props.findings.items.properties.dimension.enum, [...DIMENSIONS]);
  for (const key of REVIEW_TOOL.input_schema.required) assert.ok(key in review, `sample lacks ${key}`);
  for (const key of Object.keys(review)) assert.ok(key in props, `schema lacks ${key}`);
  for (const key of Object.keys(finding)) assert.ok(key in props.findings.items.properties, `findings schema lacks ${key}`);

  assert.deepEqual(Object.keys(SPLIT_TOOL.input_schema.properties.issues.items.properties).sort(), Object.keys(split.issues[0]).sort());
  assert.deepEqual(SPLIT_TOOL.input_schema.properties.issues.items.properties.type.enum, ["story", "task"]);
  assert.equal(IMPROVE_TOOL.input_schema.properties.proposals.items.required.includes("finding_id"), true);
  assert.deepEqual(FINALIZE_TOOL.input_schema.required, ["prd_markdown"]);
});

test("every tool schema forbids extra properties at its top level", () => {
  for (const tool of [REVIEW_TOOL, IMPROVE_TOOL, FINALIZE_TOOL, SPLIT_TOOL]) {
    assert.equal(tool.input_schema.additionalProperties, false, tool.name);
  }
});
