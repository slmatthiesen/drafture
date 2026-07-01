/**
 * Langfuse LLM-observability wiring (optional, config-gated). When LANGFUSE_PUBLIC_KEY
 * + LANGFUSE_SECRET_KEY are set, every LLM call is traced — model, prompt, completion,
 * token usage, USD cost, latency — to the operator's Langfuse project via the
 * {@link ../llm/tracingProvider.TracingProvider} decorator. Unset → disabled, no
 * client, zero overhead. Every Langfuse call here is BEST-EFFORT: a tracing failure
 * must never break a user's generation, so all of it is swallowed.
 *
 * This is distinct from `obs/telemetry.ts` (the one-line-per-request stdout metrics,
 * which deliberately carry NO prompt text): Langfuse is the operator's private project,
 * so it captures the full prompt/completion for debugging + prompt iteration.
 */
import { Langfuse } from "langfuse";

import type { Config } from "../config.js";
import type { Usage } from "../llm/provider.js";
import { llmCostUsd, type LlmPricing } from "../guards/spend.js";

/** One LLM call to record: what went in, what came out, and what it cost. */
export interface LlmTraceEntry {
  /** The provider method traced: "generate" | "generateConfig" | "clarify". */
  operation: string;
  model: string;
  input: unknown;
  /** The result on success; undefined when the call threw. */
  output: unknown;
  usage: Usage;
  startTime: Date;
  endTime: Date;
  metadata?: Record<string, unknown>;
  /** Set when the LLM call threw — recorded as an ERROR-level generation. */
  error?: unknown;
}

export interface LlmTracer {
  record(entry: LlmTraceEntry): void;
  flush(): Promise<void>;
}

/** Build a Langfuse-backed tracer, or null when Langfuse isn't configured (both keys
 *  required). Null lets the decorator no-op back to the bare provider. */
export function buildTracer(config: Config, pricing: LlmPricing): LlmTracer | null {
  if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) return null;
  const client = new Langfuse({
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    secretKey: config.LANGFUSE_SECRET_KEY,
    baseUrl: config.LANGFUSE_BASE_URL,
  });
  return new LangfuseTracer(client, pricing);
}

class LangfuseTracer implements LlmTracer {
  constructor(
    private readonly client: Langfuse,
    private readonly pricing: LlmPricing,
  ) {}

  record(entry: LlmTraceEntry): void {
    try {
      const trace = this.client.trace({ name: entry.operation, metadata: entry.metadata });
      trace.generation({
        name: entry.operation,
        model: entry.model,
        input: entry.input,
        output: entry.error ? undefined : entry.output,
        startTime: entry.startTime,
        endTime: entry.endTime,
        level: entry.error ? "ERROR" : "DEFAULT",
        statusMessage: entry.error ? String((entry.error as Error)?.message ?? entry.error) : undefined,
        usageDetails: {
          input: entry.usage.inputTokens,
          output: entry.usage.outputTokens,
          cache_read: entry.usage.cacheReadTokens,
          cache_write: entry.usage.cacheWriteTokens,
          total: entry.usage.inputTokens + entry.usage.outputTokens,
        },
        costDetails: { total: llmCostUsd(entry.usage, this.pricing) },
      });
    } catch {
      // Best-effort: never let tracing break a request.
    }
  }

  async flush(): Promise<void> {
    try {
      await this.client.flushAsync();
    } catch {
      /* best-effort */
    }
  }
}
