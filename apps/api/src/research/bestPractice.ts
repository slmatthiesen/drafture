/**
 * Research-on-miss (U6 / KTD4, R9). When grounding (U5) reports a topic with no
 * KB or memory hit, we research the current AWS best practice with Claude's
 * server-side `web_search` tool, normalize the answer to the KB doc shape, and
 * persist it `verified:false` — a QUARANTINE. Quarantined facts are used (so the
 * current and future requests benefit) but flagged "unverified" downstream until
 * an operator promotes them via the review CLIs (listPendingFacts / verifyFact).
 *
 * Three properties are load-bearing and explain the shape of this module:
 *  - GATED: nothing runs unless RESEARCH_ON_MISS is on, so the default forker-safe
 *    config makes zero web calls (R15).
 *  - BOUNDED: at most RESEARCH_MAX_CALLS_PER_REQUEST topics are researched per
 *    invocation (R11 cost control); extra topics are left for a later request.
 *  - GRACEFUL: a research failure, timeout, or a server-tool *error result block*
 *    (web_search returns HTTP 200 with an error object in `content`, not an
 *    exception — branch on the shape) is caught and logged, never thrown.
 *    Generation continues on the seeded KB + the model's own knowledge.
 *
 * The Anthropic client is injected so tests pass a fake (no network); the real
 * client is constructed lazily only when research is actually performed.
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import { getConfig } from "../config.js";
import type { MemoryStore, MemoryDoc } from "../store/types.js";
import type { Usage } from "../llm/provider.js";

/**
 * web_search server-tool block. Per the claude-api skill the current variant for
 * Opus 4.8 / Sonnet 4.6 is `web_search_20260209` (dynamic filtering); the
 * installed SDK (@anthropic-ai/sdk@0.106.0) now types it as
 * `Anthropic.WebSearchTool20260209`, so the constant is typed against the SDK for
 * ground-truth correctness. Still isolated as a single constant so swapping the
 * variant stays a one-line change, and still passed through our own loosely-typed
 * ResearchClient seam (below) so a fake can drive it without the full SDK.
 */
const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20260209 = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3,
};

/** Per-topic token ceiling — research answers are short normalized facts. */
const RESEARCH_MAX_TOKENS = 1024;

/**
 * Minimal client surface we depend on, so a fake can satisfy it without the
 * whole Anthropic SDK and so the real SDK shape can change underneath us without
 * touching callers. The real `Anthropic` client is cast to this at construction.
 */
export interface ResearchClient {
  messages: { create(body: Record<string, unknown>): Promise<ResearchResponse> };
}

interface ResearchContentBlock {
  type: string;
  text?: string;
  /** web_search_tool_result: a LIST on success, an error OBJECT on failure. */
  content?: unknown;
  [key: string]: unknown;
}

interface ResearchRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ResearchResponse {
  content?: ResearchContentBlock[];
  usage?: ResearchRawUsage | null;
  stop_reason?: string | null;
}

/** The slice of Config research needs — Config satisfies it structurally. */
export interface ResearchConfig {
  RESEARCH_ON_MISS: boolean;
  RESEARCH_MAX_CALLS_PER_REQUEST: number;
  LLM_MODEL: string;
  ANTHROPIC_API_KEY: string;
}

export interface ResearchOptions {
  /** Detected topics with no KB/memory hit (U5 `missingTopics`). */
  topics: string[];
  memory: MemoryStore;
  /** Injected for tests; the real Anthropic client is built lazily when absent. */
  anthropic?: ResearchClient;
  /** Defaults to the validated runtime config. */
  config?: ResearchConfig;
  /** Report each research call's token usage to the spend ledger (wired by U9). */
  onSpend?: (usage: Usage) => void;
}

export interface ResearchSummary {
  /** Topics we attempted to research (within the per-request cap). */
  researched: string[];
  /** Docs successfully normalized + quarantined (`verified:false`). */
  persisted: MemoryDoc[];
  /** Topics whose research failed/degraded; never throws. */
  failures: string[];
  /** Number of web_search API calls actually issued (for telemetry/ledger). */
  calls: number;
}

interface NormalizedFact {
  fact: string;
  rationale: string;
  source: string;
}

function mapUsage(raw: ResearchRawUsage | null | undefined): Usage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw?.cache_creation_input_tokens ?? 0,
  };
}

/** True when a web_search_tool_result carries an error object instead of a result list. */
function hasSearchError(content: ResearchContentBlock[]): boolean {
  return content.some(
    (b) => b.type === "web_search_tool_result" && !Array.isArray(b.content),
  );
}

/** First result URL across any successful web_search_tool_result block. */
function firstSourceUrl(content: ResearchContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result && typeof result === "object" && typeof (result as { url?: unknown }).url === "string") {
        return (result as { url: string }).url;
      }
    }
  }
  return undefined;
}

/** Concatenate all text blocks (the model's normalized answer). */
function collectText(content: ResearchContentBlock[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** Pull the first balanced JSON object out of the text (tolerates ```json fences and prose). */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function normalize(content: ResearchContentBlock[]): NormalizedFact | undefined {
  const json = extractJsonObject(collectText(content));
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const fact = typeof obj.fact === "string" ? obj.fact.trim() : "";
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  if (!fact || !rationale) return undefined; // a fact without a why is not useful grounding
  const parsedSource = typeof obj.source === "string" ? obj.source.trim() : "";
  const source = parsedSource || firstSourceUrl(content) || "";
  return { fact, rationale, source };
}

function buildPrompt(topic: string): string {
  return [
    `Research the current AWS best practice for the topic: "${topic}".`,
    "Use the web_search tool to find authoritative, up-to-date guidance — prefer official AWS documentation, the Well-Architected Framework, and AWS Prescriptive Guidance.",
    "Then respond with ONLY a single JSON object and no prose around it:",
    '{"fact": "<one concise best-practice statement>", "rationale": "<why it matters / the tradeoff>", "source": "<the source URL you used>"}',
  ].join("\n");
}

/** Research one topic. Returns a normalized fact + usage, or a failure reason. Never throws. */
async function researchTopic(
  topic: string,
  client: ResearchClient,
  config: ResearchConfig,
): Promise<{ fact?: NormalizedFact; usage: Usage; error?: string }> {
  let response: ResearchResponse;
  try {
    response = await client.messages.create({
      model: config.LLM_MODEL,
      max_tokens: RESEARCH_MAX_TOKENS,
      messages: [{ role: "user", content: buildPrompt(topic) }],
      tools: [WEB_SEARCH_TOOL],
    });
  } catch (err) {
    // Timeout / network / API error — degrade gracefully.
    return { usage: mapUsage(undefined), error: err instanceof Error ? err.message : String(err) };
  }

  const usage = mapUsage(response.usage);
  const content = response.content ?? [];

  // Server-tool errors come back as a result block (HTTP 200), not an exception.
  const searchErrored = hasSearchError(content);
  const fact = normalize(content);
  if (!fact) {
    return {
      usage,
      error: searchErrored ? "web_search returned an error result" : "no usable fact in research response",
    };
  }
  return { fact, usage };
}

/**
 * Research the missing topics and quarantine the results in MemoryStore. Bounded,
 * gated, and graceful — see the module header for the why behind each.
 */
export async function researchMissingTopics(options: ResearchOptions): Promise<ResearchSummary> {
  const { topics, memory, anthropic, config = getConfig(), onSpend } = options;
  const empty: ResearchSummary = { researched: [], persisted: [], failures: [], calls: 0 };

  // GATE: off by default — no web calls, no client construction.
  if (!config.RESEARCH_ON_MISS) return empty;
  const cap = config.RESEARCH_MAX_CALLS_PER_REQUEST;
  if (cap <= 0 || topics.length === 0) return empty;

  // BOUND: research the top-N misses; leave the rest for a later request.
  const toResearch = topics.slice(0, cap);

  const client = anthropic ?? buildClient(config);

  const summary: ResearchSummary = { researched: [], persisted: [], failures: [], calls: 0 };
  for (const topic of toResearch) {
    summary.researched.push(topic);
    summary.calls += 1;
    const { fact, usage, error } = await researchTopic(topic, client, config);
    // Each call is reportable to the spend ledger (caller wires onSpend).
    onSpend?.(usage);

    if (!fact) {
      summary.failures.push(topic);
      // Observable but non-fatal — generation proceeds on KB + model knowledge.
      console.warn(`[research] topic "${topic}" degraded: ${error ?? "unknown"}`);
      continue;
    }

    const now = Date.now();
    const doc = memory.upsert({
      id: randomUUID(),
      topic,
      fact: fact.fact,
      rationale: fact.rationale,
      source: fact.source,
      verified: false, // QUARANTINE — used but flagged until operator review (KTD4)
      provenance: "research",
      createdAt: now,
      updatedAt: now,
    });
    summary.persisted.push(doc);
  }
  return summary;
}

/**
 * Construct the real Anthropic client only when research actually runs (callers
 * that inject a client — e.g. tests — never reach this). Cast to our minimal
 * ResearchClient interface in one place so a fake can satisfy it without the full
 * SDK and so the response shape can drift underneath us without touching callers.
 */
function buildClient(config: ResearchConfig): ResearchClient {
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) as unknown as ResearchClient;
}
