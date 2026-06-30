/**
 * Offline design + reference-Terraform generator (operator tool, dogfood/corpus).
 *
 * Drives the SAME production pipeline as /api/generate + /api/config — grounding,
 * generation, deterministic cost, the security floor, the structural-completeness
 * gate, and the Terraform wire-up validator — but from the CLI, writing artifacts
 * to disk instead of serving a request. Used to regenerate the dogfood packs and to
 * batch-generate corpus candidates. It does NOT pass through the spend ledger/daily
 * ceiling, so a Sonnet run spends UNCAPPED real dollars — mind the model.
 *
 * Provider follows env: default Anthropic (LLM_MODEL), or set LLM_PROVIDER=glm
 * LLM_MODEL=glm-4.5-flash for a $0 run.
 *
 * Run:
 *   pnpm --filter @drafture/api exec node --env-file=../../.env --import tsx \
 *     scripts/generateDesign.ts --prompt <file> [--answers <file.json>] \
 *     [--tier budget|balanced|resilient|all] [--out <dir>] [--persist]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts, trafficVolumeScale } from "../src/pipeline/cost.js";
import { tagDesign } from "../src/pipeline/tags.js";
import { hashPrompt } from "../src/store/responseCache.js";
import { runAllProperties } from "../test/golden/properties.js";
import {
  REFERENCE_WARNING_HEADER,
  annotateWireupGaps,
  detectWireupGaps,
  flagIfIncomplete,
  stripCodeFence,
} from "../src/routes/config.js";
import type { Tier } from "../src/schema/architecture.js";

interface Args {
  prompt: string;
  answers: string[];
  tiers: string[];
  out: string;
  persist: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const promptPath = get("--prompt");
  if (!promptPath) {
    console.error("usage: generateDesign.ts --prompt <file> [--answers <file.json>] [--tier all] [--out <dir>] [--persist]");
    process.exit(1);
  }
  const answersPath = get("--answers");
  const answers = answersPath ? (JSON.parse(readFileSync(answersPath, "utf8")) as string[]) : [];
  const tierArg = get("--tier") ?? "all";
  const tiers = tierArg === "all" ? ["budget", "balanced", "resilient"] : [tierArg];
  return {
    prompt: readFileSync(promptPath, "utf8").trim(),
    answers,
    tiers,
    out: get("--out") ?? "out",
    persist: a.includes("--persist"),
  };
}

function renderReferenceTf(raw: string): { code: string; gaps: string[] } {
  const cleaned = stripCodeFence(raw);
  const gaps = detectWireupGaps(cleaned).map((g) => g.id);
  return { code: REFERENCE_WARNING_HEADER + flagIfIncomplete(annotateWireupGaps(cleaned)), gaps };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = getConfig();
  const ctx = buildAppContext(config);

  console.log(`Model: ${config.LLM_PROVIDER ?? "anthropic"}/${config.LLM_MODEL}  ·  tiers: ${args.tiers.join(", ")}`);
  console.log(`Prompt: "${args.prompt.slice(0, 100)}${args.prompt.length > 100 ? "…" : ""}"\n`);

  const { result, usage, grounding } = await generateArchitecture({
    provider: ctx.provider,
    memory: ctx.stores.memory,
    description: args.prompt,
    answers: args.answers,
    opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
  });
  const estimated = estimateCosts(result, ctx.stores.pricing, config.DEFAULT_REGION, trafficVolumeScale(args.answers));

  // The launch gate — every structural/coherence property. A corpus candidate that
  // fails here must NOT be approved (it would be served verbatim).
  const gate = runAllProperties(estimated);
  console.log(`Gate: ${gate.ok ? "PASS" : "FAIL"} (${gate.results.filter((r) => r.ok).length}/${gate.results.length} properties)`);
  for (const r of gate.results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}: ${r.reason}`);
  if (grounding.matchedPatterns.length) console.log(`Grounding: ${grounding.matchedPatterns.join(", ")}`);
  console.log(`Tokens: in ${usage.inputTokens} / out ${usage.outputTokens}\n`);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "design.json"), JSON.stringify(estimated, null, 2));
  console.log(`wrote ${join(args.out, "design.json")}`);

  for (const tierName of args.tiers) {
    const tier = estimated.tiers.find((t) => t.name === tierName) as Tier | undefined;
    if (!tier) {
      console.error(`  ! no tier '${tierName}' in result`);
      continue;
    }
    const { result: raw } = await ctx.provider.generateConfig(tier, { maxTokens: 32_000 });
    const { code, gaps } = renderReferenceTf(raw);
    const file = join(args.out, `${tierName}.tf`);
    writeFileSync(file, code);
    console.log(`wrote ${file}${gaps.length ? `  ⚠ wire-up gaps: ${gaps.join(", ")}` : "  ✓ no wire-up gaps"}`);
  }

  if (args.persist) {
    const promptHash = hashPrompt({
      description: args.prompt,
      answers: args.answers,
      round: 0,
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
    });
    const { id, status } = ctx.stores.generations.upsert({
      promptHash,
      description: args.prompt,
      answers: args.answers,
      model: config.LLM_MODEL,
      region: config.DEFAULT_REGION,
      recommendedTier: estimated.recommendedTier,
      tags: tagDesign(estimated),
      body: JSON.stringify(estimated),
      clientIp: "offline-script",
    });
    console.log(`\npersisted generation ${id} (status ${status}) — approve with reviewGenerations.ts, then backfillEmbeddings.ts`);
  }
}

void main();
