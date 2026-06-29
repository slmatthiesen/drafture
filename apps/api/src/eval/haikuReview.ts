/**
 * Haiku generation-review harness — the "Haiku generates, the operator judges" loop.
 *
 * Drives golden prompts through the REAL generation pipeline under whatever
 * LLM_MODEL is set (point it at claude-haiku-4-5), runs the deterministic property
 * gate, and DUMPS each full design to disk so a human/CLI reviewer can judge quality
 * the properties can't see (recommendation sense, tier coherence, verbosity, node
 * appropriateness). Prints the automated pass-rate; the dumped designs are the
 * qualitative second gate.
 *
 * Cost note: this spends real (Haiku-cheap) tokens — start with a small subset.
 *
 * Run (subset, default 1 per category):
 *   LLM_MODEL=claude-haiku-4-5 pnpm --filter @drafture/api exec \
 *     node --env-file=../../.env --import tsx src/eval/haikuReview.ts --out <dir>
 * Flags: --all (full set) · --category <c> · --limit N · --ids a,b,c · --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { ClaudeProvider } from "../llm/claude.js";
import { getDb, createStores } from "../store/sqlite.js";
import { seedKnowledgeBase } from "../store/kbLoader.js";
import { generateArchitecture } from "../pipeline/generate.js";
import { estimateCosts } from "../pipeline/cost.js";
import { runAllProperties } from "../../test/golden/properties.js";
import { GOLDEN_PROMPTS, type GoldenPrompt } from "../../test/golden/prompts.js";
import type { ArchitectureResult } from "../schema/architecture.js";
import type { Usage } from "../llm/provider.js";

// Honest Haiku 4.5 list prices ($/MTok) — independent of the ledger's LLM_PRICE_* config.
const HAIKU = { in: 1, out: 5, cacheW: 1.25, cacheR: 0.1 };
const usd = (u: Usage): number =>
  (u.inputTokens * HAIKU.in +
    u.outputTokens * HAIKU.out +
    u.cacheWriteTokens * HAIKU.cacheW +
    u.cacheReadTokens * HAIKU.cacheR) /
  1_000_000;

function selectPrompts(): GoldenPrompt[] {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--all")) return [...GOLDEN_PROMPTS];
  const ids = flag("--ids");
  if (ids) {
    const set = new Set(ids.split(","));
    return GOLDEN_PROMPTS.filter((p) => set.has(p.id));
  }
  const category = flag("--category");
  if (category) return GOLDEN_PROMPTS.filter((p) => p.category === category);
  const limit = flag("--limit");
  if (limit) return GOLDEN_PROMPTS.slice(0, Number(limit));
  // Default smoke subset: the first prompt of each category.
  const seen = new Set<string>();
  return GOLDEN_PROMPTS.filter((p) => (seen.has(p.category) ? false : (seen.add(p.category), true)));
}

function renderDesign(
  prompt: GoldenPrompt,
  design: ArchitectureResult,
  props: ReturnType<typeof runAllProperties>,
  usage: Usage,
): string {
  const lines: string[] = [];
  const verdict = props.ok ? "✅ PASS" : "❌ FAIL";
  lines.push(`## ${prompt.id} — ${verdict}  (${prompt.category})`);
  lines.push(`**Prompt:** ${prompt.description}`);
  lines.push(`**Recommended tier:** ${design.recommendedTier ?? "—"} · out ${usage.outputTokens} tok · ~$${usd(usage).toFixed(4)}`);
  if (!props.ok) {
    lines.push(`**Property failures:**`);
    for (const r of props.results.filter((x) => !x.ok)) lines.push(`  - ❌ ${r.name}: ${r.reason}`);
  }
  for (const t of design.tiers ?? []) {
    lines.push(`\n### tier: ${t.name} — ${t.summary}`);
    lines.push(`nodes (${(t.nodes ?? []).length}):`);
    for (const n of t.nodes ?? []) lines.push(`  - ${n.awsService} — ${n.role}${n.security ? `  [sec: ${n.security}]` : ""}`);
    lines.push(`edges (${(t.edges ?? []).length}): ${(t.edges ?? []).map((e) => `${e.from}→${e.to}(${e.payload})`).join(", ")}`);
    if (t.tradeoffs?.length) lines.push(`tradeoffs: ${t.tradeoffs.join("; ")}`);
  }
  lines.push(`\n### keyDecisions (${(design.keyDecisions ?? []).length}):`);
  for (const k of design.keyDecisions ?? []) {
    lines.push(`  - **${k.decision}** → ${k.chosen}`);
    if (k.alternativesConsidered) lines.push(`      alts: ${k.alternativesConsidered}`);
    if (k.rationale) lines.push(`      why: ${k.rationale}`);
  }
  lines.push(`\n### securityFloor (${(design.securityFloor ?? []).length} lines): ${(design.securityFloor ?? []).slice(0, 4).join(" · ")}${(design.securityFloor ?? []).length > 4 ? " …" : ""}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1]! : "./.haiku-eval";
  mkdirSync(outDir, { recursive: true });

  const config = loadConfig();
  const db = getDb(config.DB_PATH);
  const stores = createStores(db);
  seedKnowledgeBase(stores);
  const provider = ClaudeProvider.fromConfig(config);

  const prompts = selectPrompts();
  console.log(`Model ${config.LLM_MODEL} · ${prompts.length} prompt(s) · region ${config.DEFAULT_REGION}\n`);

  let passed = 0;
  let totalCost = 0;
  const reviewBlocks: string[] = [];
  const summary: { id: string; ok: boolean; out: number; cost: number; fails: string[] }[] = [];

  for (const prompt of prompts) {
    process.stdout.write(`  ${prompt.id} … `);
    try {
      const { result, usage } = await generateArchitecture({
        provider,
        memory: stores.memory,
        description: prompt.description,
      });
      const design = estimateCosts(result, stores.pricing, config.DEFAULT_REGION);
      const props = runAllProperties(design);
      const cost = usd(usage);
      totalCost += cost;
      if (props.ok) passed++;
      const fails = props.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.reason}`);
      summary.push({ id: prompt.id, ok: props.ok, out: usage.outputTokens, cost, fails });
      reviewBlocks.push(renderDesign(prompt, design, props, usage));
      writeFileSync(join(outDir, `${prompt.id}.json`), JSON.stringify({ prompt, design, props, usage }, null, 2));
      console.log(`${props.ok ? "PASS" : "FAIL"}  ${usage.outputTokens}tok $${cost.toFixed(4)}`);
    } catch (err) {
      summary.push({ id: prompt.id, ok: false, out: 0, cost: 0, fails: [`ERROR: ${err instanceof Error ? err.message : String(err)}`] });
      reviewBlocks.push(`## ${prompt.id} — ❌ ERROR\n${err instanceof Error ? err.message : String(err)}`);
      console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rate = prompts.length ? (100 * passed) / prompts.length : 0;
  const header = [
    `# Haiku review — ${config.LLM_MODEL}`,
    `Pass-rate (deterministic properties): **${passed}/${prompts.length} = ${rate.toFixed(0)}%**`,
    `Total est. cost: $${totalCost.toFixed(4)} (Haiku list prices)`,
    ``,
    `| id | ok | out tok | cost | failures |`,
    `|---|---|---|---|---|`,
    ...summary.map((s) => `| ${s.id} | ${s.ok ? "✅" : "❌"} | ${s.out} | $${s.cost.toFixed(4)} | ${s.fails.join("; ") || "—"} |`),
    ``,
  ].join("\n");

  writeFileSync(join(outDir, "REVIEW.md"), `${header}\n---\n\n${reviewBlocks.join("\n\n---\n\n")}\n`);
  console.log(`\nDeterministic pass-rate: ${passed}/${prompts.length} = ${rate.toFixed(0)}% · $${totalCost.toFixed(4)}`);
  console.log(`Review written to ${join(outDir, "REVIEW.md")} (+ per-prompt JSON).`);
  db.close();
}

void main();
