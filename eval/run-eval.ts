// Opt-in regression check against the real model. It spends tokens on your key
// (4 calls, roughly 25-40k tokens), so it is never run by `npm test`.
//
//   ANTHROPIC_API_KEY=... npm run eval
//
// Fixtures come from the portfolio repo (SOURCE_REPO overrides the location).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessage } from "../supabase/functions/_shared/anthropic.ts";
import {
  DEFAULT_MODEL,
  buildImproveRequest,
  buildReviewRequest,
  buildSplitRequest,
  parseImproveResponse,
  parseReviewResponse,
  parseSplitResponse,
  type AgentRequest,
} from "../supabase/functions/_shared/agents.ts";
import { totalTokens, type Usage } from "../supabase/functions/_shared/guardrails.ts";
import { withIds } from "../supabase/functions/_shared/schemas.ts";
import { blindSamplePrd, collapseWhitespace } from "./fixtures.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set. Set it in your own shell, then re-run.");
  process.exit(2);
}
const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
const sourceRoot = process.env.SOURCE_REPO ?? fileURLToPath(new URL("../../Portfolio site/", import.meta.url));
const fixtureDir = join(sourceRoot, "prd-to-jira", "Case study material");
if (!existsSync(join(fixtureDir, "sample-prd.md"))) {
  console.error(`Fixtures not found in ${fixtureDir}`);
  process.exit(2);
}

const samplePrd = blindSamplePrd(readFileSync(join(fixtureDir, "sample-prd.md"), "utf8"));
const improvedPrd = readFileSync(join(fixtureDir, "improved-prd.md"), "utf8");

let tokens = 0;
async function run(label: string, req: AgentRequest) {
  const res = await createMessage(req.params, apiKey as string);
  const used = totalTokens(res.usage as Usage);
  tokens += used;
  console.log(`  [${label}] ${used} tokens, stop_reason=${res.stop_reason}`);
  return res;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
}

console.log(`Model: ${model}\n`);

const sampleReview = parseReviewResponse(await run("review sample-prd", buildReviewRequest(samplePrd, model)));
check("sample-prd: verdict is not 'ready'", sampleReview.verdict !== "ready", sampleReview.verdict);
check(
  "sample-prd: success metrics flagged as a blocker",
  sampleReview.findings.some((f) => f.dimension === "success_metrics" && f.severity === "blocker"),
);
check(
  "sample-prd: Feature 2 acceptance criteria flagged",
  sampleReview.findings.some(
    (f) =>
      f.dimension === "requirements_acceptance_criteria" &&
      /feature 2|load a saved profile|load/i.test(`${f.section} ${f.quote ?? ""} ${f.issue}`),
  ),
);
check("sample-prd: missing rollout/rollback plan flagged", sampleReview.findings.some((f) => f.dimension === "rollout_rollback"));

const improvedReview = parseReviewResponse(await run("review improved-prd", buildReviewRequest(improvedPrd, model)));
check(
  "improved-prd: no blockers",
  !improvedReview.findings.some((f) => f.severity === "blocker"),
  improvedReview.findings.filter((f) => f.severity === "blocker").map((f) => f.issue).join(" | "),
);
check("improved-prd: verdict is not 'needs significant rework'", improvedReview.verdict !== "needs_significant_rework", improvedReview.verdict);

const identified = withIds(sampleReview.findings);
const fixes = parseImproveResponse(
  await run("improve sample-prd", buildImproveRequest(samplePrd, identified, model)),
  new Set(identified.map((f) => f.id)),
);
const proposed = new Set(fixes.map((p) => p.finding_id));
const missing = identified.filter((f) => f.severity !== "nice_to_have" && !proposed.has(f.id)).map((f) => f.id);
check("improver: every blocker and gap has a proposal", missing.length === 0, `missing ${missing.join(", ")}`);
const normPrd = collapseWhitespace(samplePrd);
const badQuotes = fixes.filter((p) => p.before !== null && !normPrd.includes(collapseWhitespace(p.before))).map((p) => p.finding_id);
check("improver: every 'before' is an exact quote from the PRD", badQuotes.length === 0, `not found: ${badQuotes.join(", ")}`);
check(
  "improver: assumptions are bracketed",
  fixes.some((p) => /\[[^\]]+\]/.test(p.proposed_text)),
);

const breakdown = parseSplitResponse(await run("split improved-prd", buildSplitRequest(improvedPrd, model)));
const stories = breakdown.issues.filter((i) => i.type === "story");
const tasks = breakdown.issues.filter((i) => i.type === "task");
check("splitter: at least 3 stories", stories.length >= 3, `got ${stories.length}`);
check("splitter: at least 1 task", tasks.length >= 1, `got ${tasks.length}`);
check("splitter: every story has acceptance criteria", stories.every((s) => s.acceptance_criteria.length > 0));
check("splitter: Epic description ends with a Source line", /Source:/i.test(breakdown.epic.description));
console.log(`\nSplit: 1 epic, ${stories.length} stories, ${tasks.length} tasks`);

console.log(`\nTotal tokens used: ${tokens}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
