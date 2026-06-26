import { describe, it, expect, vi } from "vitest";
import Anthropic, {
  APIConnectionError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk";

import { ClaudeProvider } from "./claude.js";
import { ProviderError } from "./provider.js";
import type { GroundedPrompt } from "./provider.js";
import { ArchitectureResultSchema } from "../schema/architecture.js";
import type { ArchitectureResult, Clarification, TierName } from "../schema/architecture.js";

// --- Test doubles -----------------------------------------------------------

function fakeClient() {
  const create = vi.fn();
  const countTokens = vi.fn();
  const finalMessage = vi.fn();
  const stream = vi.fn(() => ({ finalMessage }));
  const client = { messages: { create, countTokens, stream } } as unknown as Anthropic;
  return { client, create, countTokens, stream, finalMessage };
}

function makeProvider(client: Anthropic) {
  return new ClaudeProvider(client, {
    model: "claude-sonnet-4-6",
    maxTokens: 8000,
    effort: "medium",
  });
}

interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function toolMessage(
  toolName: string,
  input: unknown,
  usage: FakeUsage = {},
  stopReason: Anthropic.Message["stop_reason"] = "tool_use",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: stopReason,
    stop_sequence: null,
    content: [{ type: "tool_use", id: "toolu_test", name: toolName, input }],
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as unknown as Anthropic.Message;
}

const ARCHITECTURE_TOOL = "emit_architecture";
const CLARIFICATION_TOOL = "emit_clarification";

const PROMPT: GroundedPrompt = {
  staticPrefix: "SYSTEM PROMPT + FULL SECURITY BASELINES",
  volatileSuffix: "matched patterns + memory + user description",
};

// --- Fixtures ---------------------------------------------------------------

function makeTier(name: TierName): ArchitectureResult["tiers"][number] {
  return {
    name,
    summary: `${name} tier`,
    nodes: [
      {
        id: "api",
        awsService: "API Gateway",
        purpose: "Front door",
        security: ["TLS", "WAF"],
        scaling: { burst: "throttling", trivialInCore: true },
      },
    ],
    edges: [{ from: "client", to: "api", payload: "request", protocol: "HTTPS" }],
    setupSteps: ["Create the API"],
    costDrivers: [
      { service: "API Gateway", unit: "per 1k requests", estimateRange: "$0.20–$0.90", note: "" },
    ],
    burstHandling: ["built-in: throttling"],
    securityNotes: ["Safe-by-default posture applied"],
    tradeoffs: ["Cheaper than resilient"],
  };
}

function validArchitecture(): ArchitectureResult {
  return {
    assumptions: ["single region"],
    clarificationsUsed: [],
    tiers: [makeTier("budget"), makeTier("balanced"), makeTier("resilient")],
  };
}

// --- Tests ------------------------------------------------------------------

describe("ClaudeProvider.generate", () => {
  it("returns a schema-valid ArchitectureResult for a representative prompt", async () => {
    const arch = validArchitecture();
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(
      toolMessage(ARCHITECTURE_TOOL, arch, { input_tokens: 1200, output_tokens: 800 }),
    );

    const { result, usage } = await makeProvider(client).generate(PROMPT);

    expect(result).toEqual(ArchitectureResultSchema.parse(arch));
    expect(result.tiers.map((t) => t.name)).toEqual(["budget", "balanced", "resilient"]);
    expect(usage.inputTokens).toBe(1200);
    expect(usage.outputTokens).toBe(800);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("places the cache breakpoint ONLY on the static prefix (KTD11)", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(toolMessage(ARCHITECTURE_TOOL, validArchitecture()));

    await makeProvider(client).generate(PROMPT);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(Array.isArray(params.system)).toBe(true);
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[0]?.text).toBe(PROMPT.staticPrefix);
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });

    const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
    const suffixBlock = content[0] as Anthropic.TextBlockParam;
    expect(suffixBlock.text).toBe(PROMPT.volatileSuffix);
    expect(suffixBlock.cache_control ?? undefined).toBeUndefined();

    // Structured output is forced via the architecture tool.
    expect(params.tool_choice).toMatchObject({ type: "tool", name: ARCHITECTURE_TOOL });
    expect(params.tools?.[0]?.name).toBe(ARCHITECTURE_TOOL);
  });

  it("propagates cache-token usage so the caller can debit the ledger", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(
      toolMessage(ARCHITECTURE_TOOL, validArchitecture(), {
        input_tokens: 300,
        output_tokens: 900,
        cache_read_input_tokens: 4096,
        cache_creation_input_tokens: 2048,
      }),
    );

    const { usage } = await makeProvider(client).generate(PROMPT);

    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 900,
      cacheReadTokens: 4096,
      cacheWriteTokens: 2048,
    });
  });

  it("retries exactly once on a malformed response, then succeeds", async () => {
    const { client, create } = fakeClient();
    create
      .mockResolvedValueOnce(toolMessage(ARCHITECTURE_TOOL, { not: "valid" }))
      .mockResolvedValueOnce(toolMessage(ARCHITECTURE_TOOL, validArchitecture()));

    const { result } = await makeProvider(client).generate(PROMPT);

    expect(result.tiers).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable ProviderError after the retry also fails validation", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValue(toolMessage(ARCHITECTURE_TOOL, { still: "wrong" }));

    const err = await makeProvider(client)
      .generate(PROMPT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("ClaudeProvider.clarify", () => {
  it("returns needsClarification:false for a fully-specified prompt", async () => {
    const { client, create } = fakeClient();
    const payload: Clarification = { needsClarification: false, questions: [] };
    create.mockResolvedValueOnce(toolMessage(CLARIFICATION_TOOL, payload));

    const { result } = await makeProvider(client).clarify("a fully specified system");

    expect(result.needsClarification).toBe(false);
    expect(result.questions).toEqual([]);
  });

  it("returns true with at most two questions for an ambiguous prompt", async () => {
    const { client, create } = fakeClient();
    const payload: Clarification = {
      needsClarification: true,
      questions: ["Expected traffic?", "Data sensitivity?"],
    };
    create.mockResolvedValueOnce(toolMessage(CLARIFICATION_TOOL, payload));

    const { result } = await makeProvider(client).clarify("something vague");

    expect(result.needsClarification).toBe(true);
    expect(result.questions.length).toBeLessThanOrEqual(2);
  });

  it("threads prior answers into the model input", async () => {
    const { client, create } = fakeClient();
    create.mockResolvedValueOnce(
      toolMessage(CLARIFICATION_TOOL, { needsClarification: false, questions: [] }),
    );

    await makeProvider(client).clarify("desc", ["bursty traffic", "PII present"]);

    const params = create.mock.calls.at(-1)?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const userText = params.messages[0]?.content as string;
    expect(userText).toContain("bursty traffic");
    expect(userText).toContain("PII present");
  });
});

describe("ClaudeProvider error mapping", () => {
  it("surfaces RateLimitError as a retryable ProviderError without retrying", async () => {
    const { client, create } = fakeClient();
    const rateLimit = new RateLimitError(429, undefined, "rate limited", new Headers());
    create.mockRejectedValue(rateLimit);

    const err = await makeProvider(client)
      .generate(PROMPT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).cause).toBe(rateLimit);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces APIConnectionError as a retryable ProviderError", async () => {
    const { client, create } = fakeClient();
    const conn = new APIConnectionError({ message: "socket hang up" });
    create.mockRejectedValue(conn);

    const err = await makeProvider(client)
      .generate(PROMPT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).cause).toBe(conn);
  });

  it("maps a 4xx APIError to a non-retryable ProviderError", async () => {
    const { client, create } = fakeClient();
    create.mockRejectedValue(new BadRequestError(400, undefined, "bad request", new Headers()));

    const err = await makeProvider(client)
      .clarify("x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });
});

describe("ClaudeProvider.countTokens", () => {
  it("returns the SDK input-token count", async () => {
    const { client, countTokens } = fakeClient();
    countTokens.mockResolvedValueOnce({ input_tokens: 4321 });

    const n = await makeProvider(client).countTokens("some grounded prompt text");

    expect(n).toBe(4321);
    expect(countTokens).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
  });

  it("maps SDK errors from countTokens to ProviderError", async () => {
    const { client, countTokens } = fakeClient();
    countTokens.mockRejectedValueOnce(
      new RateLimitError(429, undefined, "rate limited", new Headers()),
    );

    const err = await makeProvider(client)
      .countTokens("x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});
