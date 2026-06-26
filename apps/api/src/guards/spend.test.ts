import { describe, it, expect, beforeEach } from "vitest";
import { openTempDb, createStores, type Stores } from "../store/sqlite.js";
import type { Usage } from "../llm/provider.js";
import {
  llmCostUsd,
  provisionalLlmCostUsd,
  reserveSpend,
  type LlmPricing,
} from "./spend.js";

const PRICING: LlmPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

describe("llmCostUsd", () => {
  it("sums the four token classes at their per-MTok rates", () => {
    const usage: Usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    };
    // 3 + 15 + 3.75 + 0.3
    expect(llmCostUsd(usage, PRICING)).toBeCloseTo(22.05);
  });

  it("scales linearly below a million tokens", () => {
    const usage: Usage = {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    expect(llmCostUsd(usage, PRICING)).toBeCloseTo((10_000 * 3 + 2_000 * 15) / 1_000_000);
  });
});

describe("provisionalLlmCostUsd", () => {
  it("prices the full input budget at cache-write (upper bound) plus full output", () => {
    const got = provisionalLlmCostUsd(PRICING, 12_000, 8_000);
    expect(got).toBeCloseTo((12_000 * 3.75 + 8_000 * 15) / 1_000_000);
    // Conservative: never below the true cost of a max-sized call at input rate.
    const trueMaxAtInputRate = (12_000 * 3 + 8_000 * 15) / 1_000_000;
    expect(got).toBeGreaterThanOrEqual(trueMaxAtInputRate);
  });
});

describe("reserveSpend", () => {
  let stores: Stores;
  beforeEach(() => {
    stores = createStores(openTempDb());
  });

  it("reserves under the ceiling and returns a reservation", () => {
    const res = reserveSpend(stores.spendLedger, 0.3, 5);
    expect(res.ok).toBe(true);
    expect(res.reservation?.reservationId).toBeTruthy();
    expect(res.spentTodayUsd).toBeCloseTo(0.3);
  });

  it("refuses with a friendly message once the ceiling is reached", () => {
    reserveSpend(stores.spendLedger, 0.9, 1.0);
    const res = reserveSpend(stores.spendLedger, 0.5, 1.0);
    expect(res.ok).toBe(false);
    expect(res.reservation).toBeUndefined();
    expect(res.message).toMatch(/cached results are still available/i);
    expect(res.spentTodayUsd).toBeCloseTo(0.9);
  });
});
