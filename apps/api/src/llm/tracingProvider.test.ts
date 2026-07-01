import { describe, it, expect, vi } from "vitest";

import type { Config } from "../config.js";
import type { LlmPricing } from "../guards/spend.js";
import type { LlmTracer, LlmTraceEntry } from "../obs/langfuse.js";
import { TracingProvider, withTracing } from "./tracingProvider.js";
import type { LlmProvider, ProviderResult } from "./provider.js";

const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

function fakeBase(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    clarify: vi.fn(async () => ({ result: { needed: false, questions: [] }, usage }) as ProviderResult<never>),
    generate: vi.fn(async () => ({ result: { tiers: [] }, usage }) as unknown as ProviderResult<never>),
    generateConfig: vi.fn(async () => ({ result: "resource {}", usage })),
    countTokens: vi.fn(async () => 42),
    ...overrides,
  } as LlmProvider;
}

function captureTracer(): { tracer: LlmTracer; entries: LlmTraceEntry[] } {
  const entries: LlmTraceEntry[] = [];
  return { entries, tracer: { record: (e) => entries.push(e), flush: async () => {} } };
}

describe("TracingProvider", () => {
  it("delegates and records a generate call with model + usage", async () => {
    const base = fakeBase();
    const { tracer, entries } = captureTracer();
    const p = new TracingProvider(base, tracer, "claude-sonnet-4-6");

    await p.generate({ staticPrefix: "sys", volatileSuffix: "user" }, { effort: "high" }, { kind: "budget" });

    expect(base.generate).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.operation).toBe("generate");
    expect(entries[0]!.model).toBe("claude-sonnet-4-6");
    expect(entries[0]!.usage).toEqual(usage);
    expect(entries[0]!.error).toBeUndefined();
    expect(entries[0]!.metadata).toMatchObject({ scope: "budget", effort: "high" });
  });

  it("records an ERROR entry and rethrows when the call fails", async () => {
    const boom = new Error("provider down");
    const base = fakeBase({ generateConfig: vi.fn(async () => { throw boom; }) });
    const { tracer, entries } = captureTracer();
    const p = new TracingProvider(base, tracer, "glm-4.5-flash");

    await expect(p.generateConfig({ name: "budget" } as never)).rejects.toThrow("provider down");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.error).toBe(boom);
    expect(entries[0]!.output).toBeUndefined();
  });

  it("passes countTokens through untraced", async () => {
    const base = fakeBase();
    const { tracer, entries } = captureTracer();
    const p = new TracingProvider(base, tracer, "claude-sonnet-4-6");

    expect(await p.countTokens("hello")).toBe(42);
    expect(entries).toHaveLength(0);
  });
});

describe("withTracing", () => {
  const pricing = {} as LlmPricing;

  it("returns the bare provider when Langfuse is not configured", () => {
    const base = fakeBase();
    const config = { LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined, LLM_MODEL: "claude-sonnet-4-6" } as unknown as Config;
    expect(withTracing(base, config, pricing)).toBe(base);
  });

  it("wraps the provider when both Langfuse keys are set", () => {
    const base = fakeBase();
    const config = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
      LLM_MODEL: "claude-sonnet-4-6",
    } as unknown as Config;
    expect(withTracing(base, config, pricing)).not.toBe(base);
  });
});
