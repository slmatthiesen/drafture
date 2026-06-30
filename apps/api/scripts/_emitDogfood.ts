/**
 * Offline ($0) regeneration of a dogfood pack's reference Terraform from the
 * merged deterministic emitter. Reads <pack>/design.json (an ArchitectureResult),
 * emits each tier, and writes <outDir>/<tier.name>.tf. Reports coverage + gaps.
 *
 *   node --import tsx scripts/_emitDogfood.ts <packDir> [outDir] [region]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { assembleTier } from "../src/pipeline/terraform/assemble.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

const packDir = process.argv[2];
if (!packDir) {
  console.error("usage: _emitDogfood.ts <packDir> [outDir] [region]");
  process.exit(1);
}
const outDir = process.argv[3] ?? packDir;
const region = process.argv[4] ?? "us-east-1";

mkdirSync(outDir, { recursive: true });
const design = JSON.parse(readFileSync(join(packDir, "design.json"), "utf8")) as ArchitectureResult;

for (const tier of design.tiers) {
  const { code, coverage, gaps } = assembleTier(tier, { region });
  const file = join(outDir, `${tier.name}.tf`);
  writeFileSync(file, code);
  const cov = `${coverage.templated}/${coverage.total} (${Math.round(coverage.ratio * 100)}%)`;
  const g = gaps.length ? `  ⚠ gaps:${gaps.map((x) => x.id).join(",")}` : "  gaps:0";
  const u = coverage.unsupported.length ? `  unsupported:${coverage.unsupported.join(",")}` : "";
  console.log(`${tier.name.padEnd(10)} cov ${cov.padEnd(14)}${g}${u}  -> ${file}`);
}
