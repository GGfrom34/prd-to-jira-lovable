import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSections, normalise, renderGenerated } from "./sync-lib.ts";

const sourceRoot = process.env.SOURCE_REPO ?? fileURLToPath(new URL("../../Portfolio site/", import.meta.url));
const outPath = fileURLToPath(new URL("../supabase/functions/_shared/prompts/generated.ts", import.meta.url));
const check = process.argv.includes("--check");

if (!existsSync(sourceRoot)) {
  console.error(`Source repo not found at ${sourceRoot}. Set SOURCE_REPO to the portfolio repo path.`);
  process.exit(2);
}

const rendered = renderGenerated(buildSections((rel) => readFileSync(join(sourceRoot, rel), "utf8")));

if (check) {
  const current = existsSync(outPath) ? normalise(readFileSync(outPath, "utf8")) : "";
  if (current !== rendered) {
    console.error("generated.ts is out of date. Run `npm run sync-prompts`.");
    process.exit(1);
  }
  console.log("generated.ts is up to date.");
} else {
  writeFileSync(outPath, rendered);
  console.log(`Wrote ${outPath}`);
}
