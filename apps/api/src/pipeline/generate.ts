/**
 * Generation step (U5) — the one-pass tiered architecture build.
 *
 * Assembles the grounded prompt (ground.ts, split at the cache breakpoint) and
 * hands it to the provider, which returns all three tiers in a single call. The
 * grounding telemetry (matched patterns, memory hits, missing topics) rides along
 * so the caller can log it and U6 can research the misses.
 */
import type { GenerateOptions, LlmProvider, Usage } from "../llm/provider.js";
import type { ArchitectureBeforeCost, GeneratedTier, PreHydrationArchitecture, TierName } from "../schema/architecture.js";
import type { MemoryStore } from "../store/types.js";

import { assembleGrounding } from "./ground.js";
import { hydrateArchitecture } from "./hydrate.js";
import { sanitizeGenerated } from "./sanitize.js";
import { securityFloorLines } from "./securityFloor.js";

export interface GenerateInput {
  provider: LlmProvider;
  memory: MemoryStore;
  description: string;
  answers?: string[];
  /** Cost ceiling for the call; defaults are applied by the provider (config). */
  opts?: GenerateOptions;
  /** Optional "similar designs we've shipped" block from the learning network (retrieve.ts). */
  exemplarsSection?: string;
}

export interface GroundingTelemetry {
  matchedPatterns: string[];
  memoryHits: string[];
  missingTopics: string[];
}

export interface GenerateOutput {
  result: ArchitectureBeforeCost;
  usage: Usage;
  grounding: GroundingTelemetry;
  /** Count of lean nodes whose `svc` matched no catalog entry (Layer A) — data for
   *  which service-catalog entry to add next, not guesswork. */
  catalogMiss: number;
}

export async function generateArchitecture(input: GenerateInput): Promise<GenerateOutput> {
  const { prompt, matchedPatterns, memoryHits, missingTopics } = await assembleGrounding({
    description: input.description,
    answers: input.answers,
    memory: input.memory,
    exemplarsSection: input.exemplarsSection,
  });

  const { result: pre, usage } = await input.provider.generate(prompt, input.opts);

  // Hydrate the model's LEAN node picks into full nodes via the KB service catalog
  // (Layer A) BEFORE anything else runs, so every downstream step (sanitize, the
  // security floor, cost, gates, TF, web) keeps seeing full nodes exactly as before.
  const { architecture: generated, catalogMiss } = hydrateArchitecture(pre);

  // Deterministically fix the model's most common tag error (a "private subnet"
  // tag on a managed/serverless service) before injecting the security floor.
  const cleaned = sanitizeGenerated(generated);

  // Inject the deterministic security floor from the KB — the model never emits it.
  // costDrivers are filled later by estimateCosts, so this is ArchitectureBeforeCost.
  //
  // The model no longer picks a recommended tier: the three tiers are a scale ladder
  // (low→high), so we always pre-select BALANCED — the medium-business default — and
  // let the user click up/down. recommendationRationale is intentionally empty (no
  // recommendation prose); the field is kept only for response-shape stability.
  const result: ArchitectureBeforeCost = {
    ...cleaned,
    securityFloor: securityFloorLines(),
    recommendedTier: "balanced",
    recommendationRationale: "",
  };

  return {
    result,
    usage,
    grounding: { matchedPatterns, memoryHits, missingTopics },
    catalogMiss,
  };
}

/**
 * LAZY DEFAULT (docs/plans/2026-06-30-007, fix A) — generate ONLY the budget tier.
 * The user picks a tier up front (budget by default) and we emit just that one graph
 * (~⅓ the output of the three-tier build → ~$0.10 / ~40s), then add balanced/resilient
 * on demand via {@link addTierToDesign}. `recommendedTier` is the single generated tier
 * (budget), so the UI pre-selects it; balanced/resilient are offered as "+ Add tier".
 */
export async function generateBudgetArchitecture(input: GenerateInput): Promise<GenerateOutput> {
  const { prompt, matchedPatterns, memoryHits, missingTopics } = await assembleGrounding({
    description: input.description,
    answers: input.answers,
    memory: input.memory,
    exemplarsSection: input.exemplarsSection,
  });

  const { result: pre, usage } = await input.provider.generate(prompt, input.opts, { kind: "budget" });
  const { architecture: generated, catalogMiss } = hydrateArchitecture(pre);
  const cleaned = sanitizeGenerated(generated);

  const result: ArchitectureBeforeCost = {
    ...cleaned,
    securityFloor: securityFloorLines(),
    recommendedTier: "budget",
    recommendationRationale: "",
  };

  return { result, usage, grounding: { matchedPatterns, memoryHits, missingTopics }, catalogMiss };
}

export interface AddTierInput extends GenerateInput {
  /** The already-generated budget tier — the baseline the new tier is a delta of. */
  budgetTier: GeneratedTier;
  /** Which tier to add. */
  target: TierName;
}

export interface AddTierOutput {
  /** The reconstructed target tier (BEFORE cost drivers — the route fills those). */
  tier: GeneratedTier;
  usage: Usage;
  /** Count of lean nodes whose `svc` matched no catalog entry (Layer A). */
  catalogMiss: number;
}

/**
 * The "+ Add tier" path — generate ONE tier (balanced/resilient) as a delta vs the
 * provided budget baseline and reconstruct it into a full graph. Returns just the
 * single tier; the route prices it (reusing estimateCosts over budget+added so
 * compliance detection stays consistent) and merges it into the stored design.
 */
export async function addTierToDesign(input: AddTierInput): Promise<AddTierOutput> {
  const { prompt } = await assembleGrounding({
    description: input.description,
    answers: input.answers,
    memory: input.memory,
    exemplarsSection: input.exemplarsSection,
  });

  const { result: pre, usage } = await input.provider.generate(prompt, input.opts, {
    kind: "addTier",
    budgetTier: input.budgetTier,
    target: input.target,
  });

  // Hydrate alongside the CLIENT-SENT budget tier (already full) so compliance
  // detection sees the whole design's surface, not just the new tier — a regime
  // marker ("PCI scope") stated on the budget tier's data node must still gate the
  // added tier's paid floor even if the delta doesn't restate it. The budget tier's
  // own (already-hydrated) nodes pass through hydrateNode untouched.
  const { architecture: hydrated, catalogMiss } = hydrateArchitecture({
    assumptions: [],
    clarificationsUsed: [],
    keyDecisions: [],
    tiers: [input.budgetTier, pre.tiers[0]!],
  });
  const cleaned = sanitizeGenerated({
    assumptions: [],
    clarificationsUsed: [],
    keyDecisions: [],
    tiers: [hydrated.tiers[1]!],
  });
  return { tier: cleaned.tiers[0]!, usage, catalogMiss };
}
