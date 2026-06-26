/**
 * Clarification step (U5). The provider decides whether ≤2 questions are needed
 * before generating (R2). This module owns the provider call + the round-cap
 * predicate; the API route (U9) carries the round counter and enforces the cap by
 * forcing generation once it is reached.
 */
import type { LlmProvider, ProviderResult } from "../llm/provider.js";
import type { Clarification } from "../schema/architecture.js";

/** Run the structured clarify call, returning the clarification + usage to debit. */
export function runClarify(
  provider: LlmProvider,
  description: string,
  priorAnswers?: string[],
): Promise<ProviderResult<Clarification>> {
  return provider.clarify(description, priorAnswers);
}

/**
 * The ≤2-round rule (R2). `round` is 0-based question rounds already asked. Once
 * the cap is reached the route must force generation regardless of whether the
 * model still wants to clarify, so users never get stuck in a clarify loop.
 */
export function roundCapReached(round: number, max = 2): boolean {
  return round >= max;
}
