import type { Config } from "../config.js";
import type { Usage } from "../llm/provider.js";
import type { SpendLedger, SpendReservation } from "../store/types.js";

/**
 * Global daily LLM-spend ceiling helpers (KTD7/U8). The LAST guard in the chain —
 * it runs only AFTER a response-cache MISS, because a cached hit costs no tokens and
 * must not consume budget. The reserve is transactional in the ledger (no concurrent
 * overshoot); these helpers just compute the dollar amounts and shape the result.
 */
export interface LlmPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

const PER_MTOK = 1_000_000;

export function pricingFromConfig(c: Config): LlmPricing {
  return {
    inputPerMTok: c.LLM_PRICE_INPUT_PER_MTOK,
    outputPerMTok: c.LLM_PRICE_OUTPUT_PER_MTOK,
    cacheWritePerMTok: c.LLM_PRICE_CACHE_WRITE_PER_MTOK,
    cacheReadPerMTok: c.LLM_PRICE_CACHE_READ_PER_MTOK,
  };
}

/** Actual USD cost of a completed call from measured usage (KTD7) — for reconcile + telemetry. */
export function llmCostUsd(usage: Usage, pricing: LlmPricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok) /
    PER_MTOK
  );
}

/**
 * Conservative upper-bound cost for the reserve (KTD7). We deliberately overestimate
 * so the ceiling never overshoots: the full input budget is priced at the CACHE-WRITE
 * rate (the most expensive input path) and the full output budget at the output rate.
 * `reconcile` later replaces this with the measured `llmCostUsd`.
 */
export function provisionalLlmCostUsd(
  pricing: LlmPricing,
  maxInputTokens: number,
  maxOutputTokens: number,
): number {
  return (
    (maxInputTokens * pricing.cacheWritePerMTok + maxOutputTokens * pricing.outputPerMTok) /
    PER_MTOK
  );
}

/** Build the provisional reserve amount straight from config limits + rates. */
export function provisionalLlmCostUsdFromConfig(c: Config): number {
  return provisionalLlmCostUsd(
    pricingFromConfig(c),
    c.LLM_MAX_INPUT_TOKENS,
    c.LLM_MAX_TOKENS,
  );
}

export interface ReserveResult {
  ok: boolean;
  /** Present only when ok — pass to ledger.reconcile/release after generation. */
  reservation?: SpendReservation;
  spentTodayUsd: number;
  ceilingUsd: number;
  /** Friendly refusal text when ok=false (route serves a 503/429). */
  message?: string;
}

/**
 * Reserve provisional spend against the daily ceiling. Returns a structured result;
 * the route refuses with a friendly message when the budget is exhausted (cache-only
 * for the rest of the day).
 */
export async function reserveSpend(
  ledger: SpendLedger,
  provisionalUsd: number,
  ceilingUsd: number,
): Promise<ReserveResult> {
  const r = await ledger.reserve(provisionalUsd, ceilingUsd);
  if (!r.ok) {
    return {
      ok: false,
      spentTodayUsd: r.spentTodayUsd,
      ceilingUsd: r.ceilingUsd,
      message:
        "Daily generation budget reached; cached results are still available. Please try again tomorrow.",
    };
  }
  return {
    ok: true,
    reservation: r,
    spentTodayUsd: r.spentTodayUsd,
    ceilingUsd: r.ceilingUsd,
  };
}
