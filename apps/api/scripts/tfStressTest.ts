/**
 * Deterministic-Terraform stress test — generalization / overfit detector.
 *
 * Runs many designs through the deterministic emitter and (optionally) `terraform
 * validate`, then reports the three numbers that matter: template COVERAGE, the
 * zero-wire-up-gap rate, and the `terraform validate` pass rate. Its headline output
 * is the UNSUPPORTED-SERVICE HISTOGRAM — which services force the LLM fallback most
 * often — so the next emitter to build is obvious instead of guessed.
 *
 * Two input modes:
 *   --designs <dir>     Validate existing design.json files under <dir> (recursive).
 *                       $0 — no LLM. Best for regression / a fast generalization pass.
 *   --prompts <file>    Generate a fresh design per prompt via the SAME pipeline as
 *                       /api/generate, then test it. Costs LLM $ (use LLM_PROVIDER=glm
 *                       for $0). <file> is a JSON array of strings, or of
 *                       { "description": string, "answers"?: string[] }.
 *
 * Options:
 *   --terraform <path>  Enable `terraform validate` with this binary (else coverage +
 *                       gaps only — still a strong, $0 signal).
 *   --out <dir>         Where to write the emitted .tf (default: a temp dir).
 *   --region <r>        Emit region (default: config DEFAULT_REGION).
 *
 * Examples:
 *   node --import tsx scripts/tfStressTest.ts --designs ../../dogfood --terraform /path/to/terraform
 *   LLM_PROVIDER=glm LLM_MODEL=glm-4.5-flash node --env-file=../../.env --import tsx \
 *     scripts/tfStressTest.ts --prompts prompts.json --terraform terraform
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts, trafficVolumeScale } from "../src/pipeline/cost.js";
import { assembleTier } from "../src/pipeline/terraform/assemble.js";
import type { ArchitectureResult } from "../src/schema/architecture.js";

interface Args {
  designsDir?: string;
  promptsFile?: string;
  terraform?: string;
  out: string;
  region?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | undefined => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
  return {
    designsDir: get("--designs"),
    promptsFile: get("--prompts"),
    terraform: get("--terraform"),
    out: get("--out") ?? mkdtempSync(join(tmpdir(), "tfstress-")),
    region: get("--region"),
  };
}

/** Recursively find every design.json under a directory. */
function findDesigns(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findDesigns(full));
    else if (entry === "design.json") out.push(full);
  }
  return out;
}

interface TierResult {
  design: string;
  tier: string;
  total: number;
  templated: number;
  ratio: number;
  gaps: string[];
  unsupported: string[];
  validate?: "pass" | "fail" | "skipped";
  validateError?: string;
}

function validateTf(terraform: string, code: string, dir: string, pluginCache: string): { ok: boolean; error?: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tf"), code);
  const env = { ...process.env, TF_PLUGIN_CACHE_DIR: pluginCache, TF_IN_AUTOMATION: "1" };
  try {
    execFileSync(terraform, ["init", "-no-color", "-input=false", "-backend=false"], { cwd: dir, env, stdio: "pipe" });
    execFileSync(terraform, ["validate", "-no-color"], { cwd: dir, env, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    const out = (err as { stdout?: Buffer; stderr?: Buffer });
    const msg = `${out.stdout?.toString() ?? ""}${out.stderr?.toString() ?? ""}`.match(/Error:.*/)?.[0] ?? String(err);
    return { ok: false, error: msg };
  }
}

async function loadDesigns(args: Args): Promise<{ name: string; result: ArchitectureResult }[]> {
  if (args.designsDir) {
    return findDesigns(args.designsDir).map((p) => ({
      name: p.replace(/\\/g, "/").split("/").slice(-2)[0] ?? p,
      result: JSON.parse(readFileSync(p, "utf8")) as ArchitectureResult,
    }));
  }
  if (!args.promptsFile) {
    console.error("provide --designs <dir> or --prompts <file>");
    process.exit(1);
  }
  // Generate mode — drive the real pipeline per prompt (LLM $).
  const config = getConfig();
  const ctx = buildAppContext(config);
  const raw = JSON.parse(readFileSync(args.promptsFile, "utf8")) as (string | { description: string; answers?: string[] })[];
  const prompts = raw.map((p) => (typeof p === "string" ? { description: p, answers: [] as string[] } : { description: p.description, answers: p.answers ?? [] }));
  const out: { name: string; result: ArchitectureResult }[] = [];
  for (const [i, p] of prompts.entries()) {
    process.stdout.write(`generating ${i + 1}/${prompts.length}: "${p.description.slice(0, 60)}"… `);
    const { result } = await generateArchitecture({
      provider: ctx.provider,
      memory: ctx.stores.memory,
      description: p.description,
      answers: p.answers,
      opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
    });
    const estimated = estimateCosts(result, ctx.stores.pricing, config.DEFAULT_REGION, trafficVolumeScale(p.answers));
    out.push({ name: `gen-${i + 1}`, result: estimated });
    console.log("done");
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Region default is a literal so --designs mode stays $0 (no config / API key needed);
  // generate mode resolves its own config inside loadDesigns().
  const region = args.region ?? "us-east-1";
  const designs = await loadDesigns(args);
  const pluginCache = join(args.out, ".tf-plugin-cache");
  if (args.terraform) mkdirSync(pluginCache, { recursive: true });

  const results: TierResult[] = [];
  for (const { name, result } of designs) {
    for (const tier of result.tiers) {
      const { code, coverage, gaps } = assembleTier(tier, { region });
      const dir = join(args.out, name, tier.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${tier.name}.tf`), code);
      const r: TierResult = {
        design: name,
        tier: tier.name,
        total: coverage.total,
        templated: coverage.templated,
        ratio: coverage.ratio,
        gaps: gaps.map((g) => g.id),
        unsupported: coverage.unsupported.map((id) => unsupportedServiceLabel(result, tier.name, id)),
      };
      if (args.terraform) {
        const v = validateTf(args.terraform, code, join(dir, "tf"), pluginCache);
        r.validate = v.ok ? "pass" : "fail";
        r.validateError = v.error;
      } else {
        r.validate = "skipped";
      }
      results.push(r);
      const cov = `${r.templated}/${r.total} (${Math.round(r.ratio * 100)}%)`;
      const v = r.validate === "skipped" ? "" : r.validate === "pass" ? "  ✓ tf-valid" : `  ✗ ${r.validateError}`;
      const g = r.gaps.length ? `  ⚠ gaps:${r.gaps.join(",")}` : "";
      console.log(`${name.slice(0, 22).padEnd(22)} ${tier.name.padEnd(10)} cov ${cov.padEnd(14)}${g}${v}`);
    }
  }

  // --- Summary ---
  const tiers = results.length;
  const fullyCovered = results.filter((r) => r.ratio === 1).length;
  const noGaps = results.filter((r) => r.gaps.length === 0).length;
  const validated = results.filter((r) => r.validate !== "skipped");
  const tfPass = validated.filter((r) => r.validate === "pass").length;

  const histogram = new Map<string, number>();
  for (const r of results) for (const s of r.unsupported) histogram.set(s, (histogram.get(s) ?? 0) + 1);
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n=== SUMMARY (${designs.length} designs, ${tiers} tiers) ===`);
  console.log(`fully templated : ${fullyCovered}/${tiers} (${pct(fullyCovered, tiers)})`);
  console.log(`zero wire-up gap: ${noGaps}/${tiers} (${pct(noGaps, tiers)})`);
  if (validated.length) console.log(`terraform valid : ${tfPass}/${validated.length} (${pct(tfPass, validated.length)})`);
  if (ranked.length === 0) {
    console.log(`unsupported     : none — every service is templated 🎉`);
  } else {
    console.log(`unsupported services (build these emitters next):`);
    for (const [svc, n] of ranked) console.log(`  ${String(n).padStart(3)}×  ${svc}`);
  }
  for (const r of validated.filter((x) => x.validate === "fail")) {
    console.log(`  ✗ ${r.design}/${r.tier}: ${r.validateError}`);
  }
  console.log(`\nartifacts: ${args.out}`);
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

/** Map an unsupported node id back to its awsService for the histogram. */
function unsupportedServiceLabel(result: ArchitectureResult, tierName: string, nodeId: string): string {
  const tier = result.tiers.find((t) => t.name === tierName);
  return tier?.nodes.find((n) => n.id === nodeId)?.awsService ?? nodeId;
}

void main();
