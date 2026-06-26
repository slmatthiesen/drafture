import Anthropic, { APIConnectionError, APIError, RateLimitError } from "@anthropic-ai/sdk";
import type { z } from "zod";

import type { Config } from "../config.js";
import {
  ArchitectureResultSchema,
  ClarificationSchema,
  architectureJsonSchema,
  clarificationJsonSchema,
} from "../schema/architecture.js";
import type { ArchitectureResult, Clarification } from "../schema/architecture.js";
import { ProviderError } from "./provider.js";
import type {
  GenerateOptions,
  GroundedPrompt,
  LlmProvider,
  ProviderResult,
  Usage,
} from "./provider.js";

/**
 * Structured output is delivered via forced tool use: SDK 0.65.0 predates the
 * `output_config.format` / `messages.parse()` structured-output surface the
 * claude-api skill documents, so we register the architecture JSON Schema as a
 * tool and force the model to call it. The `tool_use.input` block is the typed
 * object, validated with the matching zod schema. (See final-report note.)
 */
const ARCHITECTURE_TOOL = "emit_architecture";
const CLARIFICATION_TOOL = "emit_clarification";

/**
 * Above this `max_tokens` a non-streaming request risks the SDK's HTTP timeout
 * (claude-api skill), so we stream and collect the final message instead.
 */
const STREAMING_THRESHOLD = 16_000;

const CLARIFY_SYSTEM = [
  "You are the clarification gate for an AWS architecture design tool.",
  "Given a system description, decide whether you need to ask the user anything",
  "before producing a safe, three-tier AWS design. Prefer to proceed: only ask",
  "when a genuinely load-bearing detail is missing (e.g. expected traffic shape,",
  "data sensitivity, or a hard constraint). Ask at most two short questions. If",
  "the description is sufficient, return needsClarification=false with no questions.",
].join(" ");

interface ClaudeSettings {
  model: string;
  maxTokens: number;
  /**
   * Resolved generation effort. SDK 0.65.0 exposes no `output_config.effort`,
   * so this is carried for forward-compatibility and config parity but is not
   * sent on the wire yet (see final-report note).
   */
  effort: "low" | "medium" | "high";
}

/**
 * Provider-abstracted Claude implementation (KTD2). Accepts an injected
 * Anthropic client so tests can mock the SDK without touching the network.
 */
export class ClaudeProvider implements LlmProvider {
  constructor(
    private readonly client: Anthropic,
    private readonly settings: ClaudeSettings,
  ) {}

  /** Build from validated config; the launch default model is claude-sonnet-4-6 (KTD2). */
  static fromConfig(config: Config, client?: Anthropic): ClaudeProvider {
    const resolved = client ?? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return new ClaudeProvider(resolved, {
      model: config.LLM_MODEL,
      maxTokens: config.LLM_MAX_TOKENS,
      effort: config.LLM_EFFORT,
    });
  }

  async generate(
    prompt: GroundedPrompt,
    opts?: GenerateOptions,
  ): Promise<ProviderResult<ArchitectureResult>> {
    const maxTokens = opts?.maxTokens ?? this.settings.maxTokens;
    // KTD11: the cache breakpoint sits ONLY on the static prefix (system prompt
    // + full security baselines). The volatile suffix follows in the user turn
    // with no cache_control, so the per-request content never poisons the key.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: maxTokens,
      system: [
        {
          type: "text",
          text: prompt.staticPrefix,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: prompt.volatileSuffix }] },
      ],
      tools: [
        {
          name: ARCHITECTURE_TOOL,
          description:
            "Return the three-tier AWS architecture as a single structured object. " +
            "Call this exactly once with the complete design.",
          input_schema: toToolInputSchema(architectureJsonSchema()),
        },
      ],
      tool_choice: { type: "tool", name: ARCHITECTURE_TOOL, disable_parallel_tool_use: true },
    };

    return this.structuredCall(params, ARCHITECTURE_TOOL, ArchitectureResultSchema);
  }

  async clarify(
    description: string,
    priorAnswers?: string[],
  ): Promise<ProviderResult<Clarification>> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: 1024,
      system: CLARIFY_SYSTEM,
      messages: [{ role: "user", content: buildClarifyInput(description, priorAnswers) }],
      tools: [
        {
          name: CLARIFICATION_TOOL,
          description:
            "Report whether clarification is needed and, if so, the questions to ask (at most two).",
          input_schema: toToolInputSchema(clarificationJsonSchema()),
        },
      ],
      tool_choice: { type: "tool", name: CLARIFICATION_TOOL, disable_parallel_tool_use: true },
    };

    return this.structuredCall(params, CLARIFICATION_TOOL, ClarificationSchema);
  }

  async countTokens(text: string): Promise<number> {
    try {
      const res = await this.client.messages.countTokens({
        model: this.settings.model,
        messages: [{ role: "user", content: text }],
      });
      return res.input_tokens;
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Run a forced-tool-use call and validate the result. On a schema-validation
   * failure we retry exactly once (a fresh model call); a second failure throws
   * a non-retryable ProviderError. API/transport errors propagate immediately
   * (mapped in `send`) and are never retried here.
   */
  private async structuredCall<T>(
    params: Anthropic.MessageCreateParamsNonStreaming,
    toolName: string,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await this.send(params);

      if (message.stop_reason === "refusal") {
        throw new ProviderError("Model refused the request", false, message.stop_reason);
      }

      try {
        const input = extractToolInput(message, toolName);
        const result = schema.parse(input);
        return { result, usage: mapUsage(message.usage) };
      } catch (err) {
        lastError = err;
      }
    }

    throw new ProviderError(
      `Model response failed schema validation after one retry: ${describe(lastError)}`,
      false,
      lastError,
    );
  }

  private async send(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    try {
      if (params.max_tokens >= STREAMING_THRESHOLD) {
        return await this.client.messages.stream(params).finalMessage();
      }
      return await this.client.messages.create(params);
    } catch (err) {
      throw mapError(err);
    }
  }
}

function buildClarifyInput(description: string, priorAnswers?: string[]): string {
  if (!priorAnswers || priorAnswers.length === 0) return description;
  const answers = priorAnswers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${description}\n\nPrior answers:\n${answers}`;
}

/** Pull the forced tool's `input` payload out of the response content blocks. */
function extractToolInput(message: Anthropic.Message, toolName: string): unknown {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  throw new Error(`response contained no '${toolName}' tool_use block`);
}

/** Map the SDK usage onto the ledger-facing Usage shape (KTD7/KTD11). */
function mapUsage(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Translate SDK errors into the typed ProviderError chain (claude-api skill):
 * rate limits and connection failures are retryable; 4xx (validation/auth) are
 * not; 5xx are. The original error is preserved as `cause`.
 */
function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof RateLimitError) {
    return new ProviderError("Anthropic rate limit exceeded", true, err);
  }
  if (err instanceof APIConnectionError) {
    return new ProviderError("Anthropic connection error", true, err);
  }
  if (err instanceof APIError) {
    const status = err.status;
    const retryable = typeof status === "number" && status >= 500;
    const label = typeof status === "number" ? ` (${status})` : "";
    return new ProviderError(`Anthropic API error${label}: ${err.message}`, retryable, err);
  }
  return new ProviderError(`Unexpected provider error: ${describe(err)}`, false, err);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * `architectureJsonSchema()` / `clarificationJsonSchema()` emit a named schema
 * wrapped as `{ $ref, definitions }`. The Anthropic tool `input_schema` needs a
 * top-level `{ type: "object", ... }`, so resolve the single named definition
 * (no nested $refs exist — the schemas are emitted with `$refStrategy: "none"`).
 */
function toToolInputSchema(jsonSchema: Record<string, unknown>): Anthropic.Tool.InputSchema {
  const ref = jsonSchema["$ref"];
  const definitions = jsonSchema["definitions"];
  if (typeof ref === "string" && definitions && typeof definitions === "object") {
    const name = ref.split("/").pop();
    if (name) {
      const inner = (definitions as Record<string, unknown>)[name];
      if (inner && typeof inner === "object") {
        return inner as Anthropic.Tool.InputSchema;
      }
    }
  }
  return jsonSchema as unknown as Anthropic.Tool.InputSchema;
}
