/**
 * Run the internalized senior-architect budget review over the dogfood packs (offline,
 * $0). Reproduces the external reviewers' "over-built security / always-on quartet"
 * verdict BEFORE any handoff — the north-star check that WE are the checker.
 *
 *   node --import tsx scripts/_budgetReview.ts [packDir ...]
 */
import { readFileSync } from "node:fs";

import { reviewBudget } from "../src/pipeline/budgetReview.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

const packs = process.argv.slice(2);
const defaults = ["../../../dogfood/happyhourfriends/design.json", "../../../dogfood/trade-monitoring-handoff/design.json"];
const paths = packs.length ? packs : defaults;

let blockers = 0;
for (const p of paths) {
  const design = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as ArchitectureResult;
  const review = reviewBudget(design);
  const name = p.split("/").slice(-2)[0];
  console.log(`\n=== ${name} — ${review.ok ? "PASS" : "BLOCKED"} (compliance=${review.compliance}) ===`);
  for (const f of review.findings) {
    const mark = f.severity === "blocker" ? "✗" : f.severity === "ok" ? "·" : "⚠";
    console.log(`  ${mark} [${f.severity}] ${f.title}`);
    console.log(`      ${f.detail}`);
  }
  blockers += review.findings.filter((f) => f.severity === "blocker").length;
}
console.log(`\n${blockers} blocker finding(s) across ${paths.length} pack(s).`);
