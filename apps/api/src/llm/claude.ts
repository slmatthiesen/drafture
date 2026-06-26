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
 * Structured output is delivered natively: SDK 0.106 exposes
 * `output_config.format` (a server-enforced JSON Schema) plus `messages.parse()`,
 * which JSON-parses the constrained response into `parsed_output`. We pass the
 * architecture / clarification JSON Schema directly and still re-validate the
 * result with the matching zod schema before returning (defense in depth). This
 * replaces the 0.65 forced-tool-use shim (registering the schema as a tool).
 */

/**
 * Above this `max_tokens` a non-streaming request risks the SDK's HTTP timeout
 * (claude-api skill), so we stream and collect the final message instead. The
 * streamed message isn't auto-parsed, so the structured output is read from its
 * text block (see {@link extractStructuredOutput}).
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
   * Resolved generation effort. SDK 0.106 supports `output_config.effort`
   * (`low | medium | high`), so this is now sent on the wire.
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
    const effort = opts?.effort ?? this.settings.effort;
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
      // Native structured output: the model is constrained to the architecture
      // JSON Schema; `effort` tunes generation depth (both new in 0.106).
      output_config: {
        effort,
        format: { type: "json_schema", schema: toOutputSchema(architectureJsonSchema()) },
      },
    };

    return this.structuredCall(params, ArchitectureResultSchema);
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
      output_config: {
        effort: this.settings.effort,
        format: { type: "json_schema", schema: toOutputSchema(clarificationJsonSchema()) },
      },
    };

    return this.structuredCall(params, ClarificationSchema);
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
   * Run a native structured-output call and validate the result. The server
   * already constrains the response to the JSON Schema, but we re-validate with
   * the matching zod schema (defense in depth). On a parse/validation failure we
   * retry exactly once (a fresh model call); a second failure throws a
   * non-retryable ProviderError. API/transport errors propagate immediately
   * (mapped in `mapError`) and are never retried here.
   */
  private async structuredCall<T>(
    params: Anthropic.MessageCreateParamsNonStreaming,
    schema: z.ZodType<T>,
  ): Promise<ProviderResult<T>> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      let message: Anthropic.Message;
      try {
        message = await this.callModel(params);
      } catch (err) {
        // API/transport failures are mapped and thrown immediately, never
        // retried. A structured-output *parse* failure surfaced by
        // `messages.parse()` is not an API error, so fall through to the retry.
        if (isApiFailure(err)) throw mapError(err);
        lastError = err;
        continue;
      }

      if (message.stop_reason === "refusal") {
        throw new ProviderError("Model refused the request", false, message.stop_reason);
      }

      try {
        const candidate = extractStructuredOutput(message);
        const result = schema.parse(candidate);
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

  private async callModel(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    if (params.max_tokens >= STREAMING_THRESHOLD) {
      // Streamed messages aren't auto-parsed; extractStructuredOutput reads the
      // JSON text block produced under output_config.format.
      return this.client.messages.stream(params).finalMessage();
    }
    // messages.parse() runs output_config.format server-side and JSON-parses the
    // constrained response into `parsed_output`.
    return this.client.messages.parse(params);
  }
}

function buildClarifyInput(description: string, priorAnswers?: string[]): string {
  if (!priorAnswers || priorAnswers.length === 0) return description;
  const answers = priorAnswers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return `${description}\n\nPrior answers:\n${answers}`;
}

/**
 * Pull the structured object out of a response. `messages.parse()` attaches the
 * JSON-parsed object as `parsed_output`; the streaming path returns a plain
 * message, so we JSON-parse the constrained text block ourselves. zod validation
 * runs afterward in {@link ClaudeProvider.structuredCall} regardless.
 */
function extractStructuredOutput(message: Anthropic.Message): unknown {
  const parsed = (message as { parsed_output?: unknown }).parsed_output;
  if (parsed != null) return parsed;
  for (const block of message.content) {
    if (block.type === "text") return JSON.parse(block.text);
  }
  throw new Error("response contained no structured-output text block");
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

/** True for SDK API/transport errors (and already-mapped ProviderErrors) — never retried. */
function isApiFailure(err: unknown): boolean {
  return (
    err instanceof ProviderError ||
    err instanceof RateLimitError ||
    err instanceof APIConnectionError ||
    err instanceof APIError
  );
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
 * wrapped as `{ $ref, definitions }`. `output_config.format.schema` wants a
 * top-level `{ type: "object", ... }`, so resolve the single named definition
 * (no nested $refs exist — the schemas are emitted with `$refStrategy: "none"`).
 */
function toOutputSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const ref = jsonSchema["$ref"];
  const definitions = jsonSchema["definitions"];
  if (typeof ref === "string" && definitions && typeof definitions === "object") {
    const name = ref.split("/").pop();
    if (name) {
      const inner = (definitions as Record<string, unknown>)[name];
      if (inner && typeof inner === "object") {
        return inner as Record<string, unknown>;
      }
    }
  }
  return jsonSchema;
}
