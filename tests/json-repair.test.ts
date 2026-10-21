import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLoosely } from "../supabase/functions/_shared/json-repair.ts";
import { REVIEW_TOOL, normaliseToSchema, parseReview } from "../supabase/functions/_shared/schemas.ts";

const list = [{ a: "x" }, { a: "y" }];

test("valid JSON parses unchanged", () => {
  assert.deepEqual(parseJsonLoosely(JSON.stringify(list)), list);
});

test("a markdown code fence around the JSON is removed", () => {
  assert.deepEqual(parseJsonLoosely("```json\n" + JSON.stringify(list) + "\n```"), list);
  assert.deepEqual(parseJsonLoosely("```\n" + JSON.stringify(list) + "\n```"), list);
});

test("text before and after the JSON is ignored", () => {
  assert.deepEqual(parseJsonLoosely("Here are the findings: " + JSON.stringify(list) + " Hope that helps."), list);
});

test("trailing commas are removed", () => {
  assert.deepEqual(parseJsonLoosely('[{"a": "x",}, {"a": "y",},]'), list);
});

test("raw newlines and tabs inside strings are escaped", () => {
  assert.deepEqual(parseJsonLoosely('[{"a": "line one\nline two"}]'), [{ a: "line one\nline two" }]);
  assert.deepEqual(parseJsonLoosely('[{"a": "tab\there"}]'), [{ a: "tab\there" }]);
});

test("an escaped quote and an escaped backslash inside a string survive the newline repair", () => {
  const raw = '[{"a": "say \\"hi\\" and a path C:\\\\x\nnext line"}]';
  assert.deepEqual(parseJsonLoosely(raw), [{ a: 'say "hi" and a path C:\\x\nnext line' }]);
});

test("unescaped double quotes inside a string value are escaped (the production failure)", () => {
  assert.deepEqual(parseJsonLoosely('[{"a": "an unescaped "quote" inside"}]'), [{ a: 'an unescaped "quote" inside' }]);
  assert.deepEqual(
    parseJsonLoosely('[{"issue": "The "instant book" flow is undefined", "quote": "He said "hi"", "section": "Features"}]'),
    [{ issue: 'The "instant book" flow is undefined', quote: 'He said "hi"', section: "Features" }],
  );
  assert.deepEqual(parseJsonLoosely('[{"a": "multi\nline with "quotes""}]'), [{ a: 'multi\nline with "quotes"' }]);
});

test("a quote followed by a colon, comma or bracket is treated as the end of the string", () => {
  assert.deepEqual(parseJsonLoosely('{"a": "x", "b": ["y", "z"]}'), { a: "x", b: ["y", "z"] });
});

test("text that cannot be repaired throws instead of guessing", () => {
  assert.throws(() => parseJsonLoosely("not json at all"), /not parseable/);
  assert.throws(() => parseJsonLoosely('[{"a": '), /not parseable/);
});

test("a review whose findings list arrives as slightly broken JSON text is repaired end to end", () => {
  const broken =
    '```json\n[{"dimension": "scope", "severity": "gap", "section": "Scope", "quote": null, "issue": "Two\nlines",},]\n```';
  const sent = { verdict: "ready", summary: "x", findings: broken, skipped_dimensions: [] };
  const fixed = parseReview(normaliseToSchema(sent, REVIEW_TOOL.input_schema));
  assert.equal(fixed.findings.length, 1);
  assert.equal(fixed.findings[0].issue, "Two\nlines");
});
