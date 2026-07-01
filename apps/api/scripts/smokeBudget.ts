/**
 * One-shot LIVE smoke test for the lazy budget-first path (docs/plans/2026-06-30-007).
 *
 * Makes exactly ONE paid generation call — budget tier only — and reports real latency
 * + token cost, then emits the budget tier's Terraform DETERMINISTICALLY ($0/instant)
 * and reports its coverage. Calls the pipeline directly (not the HTTP route) so no
 * cache / retrieval / clarify short-circuits the measurement.
 *
 * Run:  node --env-file=../../.env --import tsx scripts/smokeBudget.ts
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateBudgetArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts, trafficVolumeScale } from "../src/pipeline/cost.js";
import { assembleTier } from "../src/pipeline/terraform/assemble.js";
import { llmCostUsd } from "../src/guards/spend.js";

const PROMPT = "A REST API for a to-do list app with user accounts and image attachments on tasks.";

async function main(): Promise<void> {
  const config = getConfig();
  const ctx = await buildAppContext(config);
  console.log(`model: ${config.LLM_MODEL}   region: ${config.DEFAULT_REGION}`);
  console.log(`prompt: "${PROMPT}"\n`);

  // --- 1. Budget-only generation (the one paid call) ---
  const t0 = Date.now();
  const gen = await generateBudgetArchitecture({
    provider: ctx.provider,
    memory: ctx.stores.memory,
    description: PROMPT,
    opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
  });
  const genMs = Date.now() - t0;

  const estimated = await estimateCosts(gen.result, ctx.stores.pricing, config.DEFAULT_REGION, trafficVolumeScale([]));
  const usd = llmCostUsd(gen.usage, ctx.pricing);
  const budget = estimated.tiers[0]!;

  console.log("=== BUDGET GENERATION (lazy default) ===");
  console.log(`tiers returned   : [${estimated.tiers.map((t) => t.name).join(", ")}]  (expect: budget only)`);
  console.log(`latency          : ${(genMs / 1000).toFixed(1)}s`);
  console.log(`tokens in/out    : ${gen.usage.inputTokens} / ${gen.usage.outputTokens}` +
    `   (cache read ${gen.usage.cacheReadTokens}, write ${gen.usage.cacheWriteTokens})`);
  console.log(`cost             : $${usd.toFixed(4)}`);
  console.log(`budget nodes/edges: ${budget.nodes.length} / ${budget.edges.length}`);
  console.log(`recommendedTier  : ${estimated.recommendedTier}`);

  // --- 2. Terraform for the budget tier — DETERMINISTIC, $0, instant ---
  const t1 = Date.now();
  const tf = assembleTier(budget, { region: config.DEFAULT_REGION });
  const tfMs = Date.now() - t1;
  const deterministic = tf.coverage.unsupported.length === 0;

  console.log("\n=== BUDGET TERRAFORM ===");
  console.log(`path             : ${deterministic ? "DETERMINISTIC ($0, no LLM)" : "PARTIAL — would LLM-fallback"}`);
  console.log(`latency          : ${tfMs}ms`);
  console.log(`coverage         : ${tf.coverage.templated}/${tf.coverage.total} (${Math.round(tf.coverage.ratio * 100)}%)`);
  console.log(`wire-up gaps     : ${tf.gaps.length === 0 ? "none" : tf.gaps.map((g) => g.id).join(", ")}`);
  console.log(`unsupported      : ${tf.coverage.unsupported.length === 0 ? "none" : tf.coverage.unsupported.join(", ")}`);
  console.log(`HCL size         : ${tf.code.length} chars`);

  console.log("\n--- budget services ---");
  for (const n of budget.nodes) console.log(`  ${n.awsService}  (${n.role})`);
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error("smoke test failed:", err);
    process.exit(1);
  },
);
