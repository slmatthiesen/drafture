import type { LlmProvider } from "../llm/provider.js";

/**
 * Hard input-token cap (KTD7/U8). The output side is bounded by the provider's
 * `max_tokens`; this bounds the INPUT side so an oversized prompt can't run up a
 * large (cache-write-premium) input bill. Returns a structured result rather than
 * throwing so the route (U9) maps it to a reply — 413 (Payload Too Large) is the
 * apt status; 400 is acceptable if the route prefers a uniform validation shape.
 */
export interface InputBudgetResult {
  ok: boolean;
  tokens: number;
  max: number;
  /** Suggested HTTP status for the route to use when ok=false. */
  statusCode: 413;
  message?: string;
}

export async function assertWithinInputBudget(
  provider: Pick<LlmProvider, "countTokens">,
  text: string,
  maxInputTokens: number,
): Promise<InputBudgetResult> {
  const tokens = await provider.countTokens(text);
  const ok = tokens <= maxInputTokens;
  return {
    ok,
    tokens,
    max: maxInputTokens,
    statusCode: 413,
    message: ok
      ? undefined
      : `Description is too large (${tokens} tokens > ${maxInputTokens} limit). Please shorten it.`,
  };
}
