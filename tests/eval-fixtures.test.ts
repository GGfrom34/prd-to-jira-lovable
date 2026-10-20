import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blindSamplePrd, collapseWhitespace } from "../eval/fixtures.ts";

const SAMPLE = join(
  process.env.SOURCE_REPO ?? fileURLToPath(new URL("../../Portfolio site/", import.meta.url)),
  "prd-to-jira/Case study material/sample-prd.md",
);

test("blindSamplePrd removes the self-describing note and the planted-gaps section", () => {
  const input =
    "# PRD\n\n*Draft v0.1 — fixture.\nSee the note (remove it so the review is a genuine blind check).*\n\n## Problem\nText.\n\n---\n\n### Known planted gaps (for testing)\n\n1. secret\n";
  const out = blindSamplePrd(input);
  assert.equal(out, "# PRD\n\n## Problem\nText.\n");
});

test("blindSamplePrd leaves a PRD without those parts unchanged", () => {
  assert.equal(blindSamplePrd("# PRD\n\n## Problem\nText.\n"), "# PRD\n\n## Problem\nText.\n");
});

test("blindSamplePrd handles Windows line endings", () => {
  assert.equal(blindSamplePrd("# PRD\r\n\r\n## Problem\r\nText.\r\n"), "# PRD\n\n## Problem\nText.\n");
});

test("the real sample-prd.md is fully blinded", { skip: !existsSync(SAMPLE) }, () => {
  const out = blindSamplePrd(readFileSync(SAMPLE, "utf8"));
  assert.doesNotMatch(out, /planted/i);
  assert.doesNotMatch(out, /Known planted gaps/);
  assert.doesNotMatch(out, /blind check/);
  assert.match(out, /## Problem/);
  assert.match(out, /### 2\. Load a saved profile/);
});

test("collapseWhitespace makes wrapped quotes comparable", () => {
  assert.equal(collapseWhitespace("a\n   b\t c  "), "a b c");
});
