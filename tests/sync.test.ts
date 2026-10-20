import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_SECTIONS,
  buildSections,
  extractSection,
  normalise,
  renderGenerated,
  toTemplateLiteral,
} from "../scripts/sync-lib.ts";

const DOC = "# Title\n\n## First\nline a\nline b\n\n## Second thing\nline c\n\n## Third\nline d\n";

test("extractSection returns the heading through the line before the next H2", () => {
  assert.equal(extractSection(DOC, "First"), "## First\nline a\nline b");
  assert.equal(extractSection(DOC, "Third"), "## Third\nline d");
});

test("extractSection matches by prefix and handles Windows line endings", () => {
  assert.equal(extractSection(DOC.replace(/\n/g, "\r\n"), "Second"), "## Second thing\nline c");
});

test("extractSection throws when the heading is missing, so source renames are noticed", () => {
  assert.throws(() => extractSection(DOC, "Missing"), /Section not found/);
});

test("toTemplateLiteral round-trips backticks, dollar-braces and backslashes", () => {
  const nasty = "a `tick` and ${not.interpolated} and back\\slash and \\n";
  const literal = toTemplateLiteral(nasty);
  assert.equal(new Function(`return ${literal}`)(), nasty);
});

test("normalise converts CRLF to LF", () => {
  assert.equal(normalise("a\r\nb"), "a\nb");
});

const SOURCE_ROOT = process.env.SOURCE_REPO ?? fileURLToPath(new URL("../../Portfolio site/", import.meta.url));
const haveSources = existsSync(join(SOURCE_ROOT, ".claude/agents/prd-quality-reviewer.md"));

test("generated.ts matches the current Claude Code agent and skill files", { skip: !haveSources }, () => {
  const rendered = renderGenerated(buildSections((rel) => readFileSync(join(SOURCE_ROOT, rel), "utf8")));
  const generated = normalise(
    readFileSync(new URL("../supabase/functions/_shared/prompts/generated.ts", import.meta.url), "utf8"),
  );
  assert.equal(generated, rendered, "run `npm run sync-prompts` and review the diff");
});

test("every source section is non-trivial and carries its key content", { skip: !haveSources }, () => {
  const sections = buildSections((rel) => readFileSync(join(SOURCE_ROOT, rel), "utf8"));
  for (const s of SOURCE_SECTIONS) assert.ok(sections[s.name].length > 300, `${s.name} looks too short`);
  assert.match(sections.reviewerRubric, /Success metrics/);
  assert.match(sections.reviewerRubric, /Rollout \/ rollback/);
  assert.match(sections.reviewerOutputFormat, /Blocker/);
  assert.match(sections.improverLoop, /explicit sign-off/);
  assert.match(sections.splitterBreakdown, /\*\*Epic\*\*/);
});
