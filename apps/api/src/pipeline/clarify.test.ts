import { describe, it, expect } from "vitest";

import type { LlmProvider, ProviderResult, GroundedPrompt, Usage } from "../llm/provider.js";
import type { ArchitectureResult, Clarification } from "../schema/architecture.js";

import { runClarify, roundCapReached } from "./clarify.js";

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// In-test provider: returns canned clarifications, no network.
function fakeProvider(clar: Clarification): { provider: LlmProvider; seen: { description?: string; priorAnswers?: string[] } } {
  const seen: { description?: string; priorAnswers?: string[] } = {};
  const provider: LlmProvider = {
    async clarify(description, priorAnswers): Promise<ProviderResult<Clarification>> {
      seen.description = description;
      seen.priorAnswers = priorAnswers;
      return { result: clar, usage: ZERO_USAGE };
    },
    async generate(_prompt: GroundedPrompt): Promise<ProviderResult<ArchitectureResult>> {
      throw new Error("generate not used in clarify tests");
    },
    async generateConfig(): Promise<ProviderResult<string>> {
      throw new Error("generateConfig not used in clarify tests");
    },
    async countTokens(text: string): Promise<number> {
      return text.length;
    },
  };
  return { provider, seen };
}

describe("runClarify", () => {
  it("returns needsClarification:false with no questions for a fully-specified prompt", async () => {
    const { provider } = fakeProvider({ needsClarification: false, questions: [] });

    const { result, usage } = await runClarify(provider, "a fully specified serverless API");

    expect(result.needsClarification).toBe(false);
    expect(result.questions).toEqual([]);
    expect(usage).toEqual(ZERO_USAGE);
  });

  it("returns ≤2 questions for an ambiguous prompt and threads prior answers", async () => {
    const { provider, seen } = fakeProvider({
      needsClarification: true,
      questions: ["Expected traffic?", "Data sensitivity?"],
    });

    const { result } = await runClarify(provider, "something vague", ["bursty"]);

    expect(result.needsClarification).toBe(true);
    expect(result.questions.length).toBeLessThanOrEqual(2);
    expect(seen.priorAnswers).toEqual(["bursty"]);
  });
});

describe("roundCapReached (≤2-round rule, R2)", () => {
  it("is false before the cap and true at/after it (route forces generation)", () => {
    expect(roundCapReached(0)).toBe(false);
    expect(roundCapReached(1)).toBe(false);
    expect(roundCapReached(2)).toBe(true);
    expect(roundCapReached(3)).toBe(true);
  });

  it("honors a custom max", () => {
    expect(roundCapReached(1, 1)).toBe(true);
    expect(roundCapReached(0, 1)).toBe(false);
  });
});
