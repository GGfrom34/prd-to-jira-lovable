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
