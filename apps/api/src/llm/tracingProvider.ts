/**
 * Provider-agnostic Langfuse tracing decorator (KTD2/R13 — one choke point, works for
 * ClaudeProvider AND GlmProvider). Wraps a base {@link LlmProvider}: every clarify /
 * generate / generateConfig call is timed and recorded to Langfuse with its prompt,
 * completion, token usage, and USD cost. `countTokens` is a local tiktoken count (no
 * model call) so it passes straight through untraced.
 *
 * Enabled only when Langfuse is configured — {@link withTracing} returns the bare
 * provider otherwise, so tests and unconfigured deploys pay nothing.
 */
import type { GeneratedTier, Clarification, PreHydrationArchitecture } from "../schema/architecture.js";

import type { Config } from "../config.js";
import type { LlmPricing } from "../guards/spend.js";
import { buildTracer, type LlmTracer } from "../obs/langfuse.js";
import type {
  LlmProvider,
  ProviderResult,
  GroundedPrompt,
  GenerateOptions,
  GenerateScope,
  Usage,
} from "./provider.js";

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export class TracingProvider implements LlmProvider {
  constructor(
    private readonly base: LlmProvider,
    private readonly tracer: LlmTracer,
    private readonly model: string,
  ) {}

  private async traced<T>(
    operation: string,
    input: unknown,
    metadata: Record<string, unknown> | undefined,
    run: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const startTime = new Date();
    try {
      const res = await run();
      this.tracer.record({ operation, model: this.model, input, output: res.result, usage: res.usage, startTime, endTime: new Date(), metadata });
      return res;
    } catch (error) {
      this.tracer.record({ operation, model: this.model, input, output: undefined, usage: ZERO_USAGE, startTime, endTime: new Date(), metadata, error });
      throw error;
    }
  }

  clarify(description: string, priorAnswers?: string[]): Promise<ProviderResult<Clarification>> {
    return this.traced("clarify", { description, priorAnswers }, undefined, () => this.base.clarify(description, priorAnswers));
  }

  generate(prompt: GroundedPrompt, opts?: GenerateOptions, scope?: GenerateScope): Promise<ProviderResult<PreHydrationArchitecture>> {
    return this.traced(
      "generate",
      `${prompt.staticPrefix}\n${prompt.volatileSuffix}`,
      { scope: scope?.kind ?? "full", effort: opts?.effort, maxTokens: opts?.maxTokens },
      () => this.base.generate(prompt, opts, scope),
    );
  }

  generateConfig(tier: GeneratedTier, opts?: { maxTokens?: number }): Promise<ProviderResult<string>> {
    return this.traced("generateConfig", tier, { tier: tier.name, maxTokens: opts?.maxTokens }, () => this.base.generateConfig(tier, opts));
  }

  countTokens(text: string): Promise<number> {
    return this.base.countTokens(text);
  }
}

/** Wrap a provider with Langfuse tracing when configured; otherwise return it unchanged. */
export function withTracing(base: LlmProvider, config: Config, pricing: LlmPricing): LlmProvider {
  const tracer = buildTracer(config, pricing);
  return tracer ? new TracingProvider(base, tracer, config.LLM_MODEL) : base;
}
