/**
 * Grounding assembly (U5) — the load-bearing prompt-cache boundary (KTD11).
 *
 * The generation prompt is split into two segments at the cache breakpoint:
 *
 *  - `staticPrefix`  — system prompt (safe-by-default mandate + generation
 *    instructions) + the FULL security-baselines block. This is IDENTICAL on
 *    every request (it is computed once at module load), so the provider can put
 *    `cache_control: ephemeral` on it and actually get a cache hit. Nothing that
 *    varies per request may appear here.
 *
 *  - `volatileSuffix` — keyword-matched reference patterns, MemoryStore hits for
 *    the detected domain topics, and the user description + answers. All of this
 *    varies per request, so it MUST live after the breakpoint: putting any of it
 *    in the prefix changes the cache key every request, so the cache never hits
 *    and the write premium (1.25×/2×) is wasted (KTD11).
 */
import securityBaselines from "@stackdraft/kb/security-baselines.json" with { type: "json" };
import referenceArchitectures from "@stackdraft/kb/reference-architectures.json" with { type: "json" };
import type { SecurityBaseline, ReferenceArchitecture } from "@stackdraft/kb";

import type { GroundedPrompt } from "../llm/provider.js";
import type { MemoryStore, MemoryDoc } from "../store/types.js";

const baselines = securityBaselines as SecurityBaseline[];
const patterns = referenceArchitectures as ReferenceArchitecture[];
const patternById = new Map(patterns.map((p) => [p.id, p] as const));

/**
 * System prompt: the safe-by-default mandate + the generation rules (a)–(f) the
 * model must follow. Static by construction — no per-request content.
 */
const SYSTEM_PROMPT = `You are Stackdraft, an AWS solutions architect. Given a plain-language description of a system to build, return ONLY a typed architecture graph that matches the provided schema — no prose outside it.

SAFE-BY-DEFAULT IS NON-NEGOTIABLE. Apply EVERY security baseline listed below to ALL THREE tiers. The full security floor is identical on every tier; it never moves.

TIERS: emit exactly three — budget, balanced, resilient — that differ ONLY along the ROBUSTNESS axis (availability + scalability): single-AZ vs multi-AZ, on-demand vs provisioned, no replica vs read replicas, etc. Cost is the CONSEQUENCE of those robustness choices, never an independent knob and never a reason to relax security. The budget tier is the MINIMUM SAFE COST: it keeps the entire security floor and must be framed that way — "budget" must never read as "cheap because insecure". Say this explicitly in the budget tier's securityNotes/tradeoffs.

BURST HANDLING: when absorbing burst is a trivial add, build it into the core and set the node's scaling.trivialInCore=true. The trivial-in-core set is exactly: DynamoDB on-demand, API Gateway throttling, CloudFront caching, Lambda reserved concurrency. Otherwise list the mechanism under burstHandling as an OPTION (e.g. Lambda provisioned concurrency, DynamoDB provisioned capacity + auto-scaling, SQS buffering) — options are not core. Default any new datastore to DynamoDB on-demand unless the description signals steady high volume, because auto-scaling cannot absorb short spikes.

NAT / EGRESS COST: when a tier places data stores in private subnets (security baseline 'no-public-data-tier'), call out the recurring NAT-gateway processing cost plus internet egress in that tier's securityNotes and burstHandling. The secure private-subnet default is NOT free and must never be presented as if it were.

EDGES: label every edge with the payload moving across it and its protocol — no unlabeled connections.

OUTPUT: assumptions, clarificationsUsed, and exactly three tiers; each tier has nodes, payload-labeled edges, ordered plain-language setupSteps, costDrivers in each service's native cost unit, burstHandling notes, NON-EMPTY securityNotes, and tradeoffs versus the other two tiers.`;

function renderSecurityBaselines(): string {
  const rules = baselines.map(
    (b, i) => `${i + 1}. [${b.id}] ${b.rule}\n   Rationale: ${b.rationale}`,
  );
  return [
    "SECURITY BASELINES — apply ALL of these to EVERY tier (the non-negotiable floor):",
    ...rules,
  ].join("\n");
}

/**
 * Computed ONCE at module load: the cacheable prefix is the same bytes on every
 * request, which is the whole point of the breakpoint (KTD11).
 */
const STATIC_PREFIX = `${SYSTEM_PROMPT}\n\n${renderSecurityBaselines()}`;

// --- Per-request detection heuristics ---------------------------------------
//
// Simple, transparent keyword/domain detection over the (lowercased) description
// + answers. Two vocabularies:
//   PATTERN_KEYWORDS — which seeded reference architectures to surface as
//     grounding (rendered from the kb import into the volatile suffix).
//   TOPIC_KEYWORDS  — domain topics we look up in MemoryStore; a topic with no
//     memory hit becomes a `missingTopic` U6 can later research-on-miss.
// Matching is start-of-word (\b<stem>) so plural/inflected forms hit ("upload"→
// "uploads", "async"→"asynchronously") without matching mid-word noise.

const PATTERN_KEYWORDS: Record<string, readonly string[]> = {
  "serverless-api": ["serverless", "lambda", "rest api", "rest", "api gateway", "json api"],
  "container-api": ["container", "docker", "fargate", "ecs", "kubernetes", "long-running", "long running", "steady", "cpu-bound", "cpu bound"],
  "queue-based-async": ["queue", "async", "background", "etl", "webhook", "upload", "notification", "decouple"],
  "static-site-api": ["static site", "static", "single-page", "spa", "website", "landing page", "blog", "marketing site"],
};

const TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  "file-uploads": ["upload", "image", "photo", "video", "media", "attachment", "file storage"],
  "async-processing": ["queue", "async", "background", "worker", "etl", "batch"],
  authentication: ["auth", "login", "sign in", "sign-in", "signup", "sign up", "user account", "accounts"],
  notifications: ["notification", "email", "sms", "push notification"],
  realtime: ["realtime", "real-time", "websocket", "live update"],
  payments: ["payment", "billing", "checkout", "stripe", "subscription"],
  search: ["full-text search", "search", "elasticsearch", "opensearch"],
  "high-throughput": ["high throughput", "high-throughput", "high volume", "high traffic", "millions of", "very large", "massive scale"],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyKeyword(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => new RegExp(`\\b${escapeRegExp(kw)}`, "i").test(haystack));
}

function detectFrom(haystack: string, vocab: Record<string, readonly string[]>): string[] {
  return Object.keys(vocab).filter((key) => {
    const keywords = vocab[key];
    return keywords !== undefined && matchesAnyKeyword(haystack, keywords);
  });
}

/** Reference-architecture ids whose keywords appear in the text (telemetry + grounding). */
export function detectPatternIds(text: string): string[] {
  return detectFrom(text.toLowerCase(), PATTERN_KEYWORDS);
}

/** Domain topics detected in the text; the basis for memory lookups + missing-topic reporting. */
export function detectTopics(text: string): string[] {
  return detectFrom(text.toLowerCase(), TOPIC_KEYWORDS);
}

// --- Assembly ----------------------------------------------------------------

export interface GroundingInput {
  description: string;
  answers?: string[];
  memory: MemoryStore;
}

export interface GroundingResult {
  prompt: GroundedPrompt;
  /** Reference-architecture ids surfaced as grounding (telemetry). */
  matchedPatterns: string[];
  /** Memory doc ids included in the suffix (telemetry). */
  memoryHits: string[];
  /** Detected topics with no memory hit — candidates for U6 research-on-miss. */
  missingTopics: string[];
}

function renderPatternsSection(patternIds: string[]): string | undefined {
  const blocks: string[] = [];
  for (const id of patternIds) {
    const p = patternById.get(id);
    if (!p) continue;
    blocks.push(
      `### ${p.name}\n` +
        `When to use: ${p.whenToUse}\n` +
        `Services: ${p.services.join(", ")}\n` +
        `Burst mechanisms: ${p.burstMechanisms.join("; ")}`,
    );
  }
  if (blocks.length === 0) return undefined;
  return `## Matched reference architectures\n${blocks.join("\n\n")}`;
}

function renderMemorySection(docs: MemoryDoc[]): string | undefined {
  if (docs.length === 0) return undefined;
  const lines = docs.map((d) => {
    // Quarantined research (verified:false) is USED but must be flagged so the
    // model — and downstream output — treat it as untrusted (KTD4).
    const flag = d.verified ? "" : "(UNVERIFIED) ";
    return `- [${d.topic}] ${flag}${d.fact} (source: ${d.source})`;
  });
  return `## Researched / cached facts\n${lines.join("\n")}`;
}

/**
 * Assemble the grounded prompt split at the cache breakpoint (KTD11). The prefix
 * is the shared static block; everything request-specific goes in the suffix.
 */
export function assembleGrounding(input: GroundingInput): GroundingResult {
  const answers = input.answers ?? [];
  const haystack = [input.description, ...answers].join("\n");

  const matchedPatterns = detectPatternIds(haystack);
  const topics = detectTopics(haystack);

  const hits = topics.length > 0 ? input.memory.search(topics) : [];
  const memoryHits = hits.map((d) => d.id);
  const hitTopics = new Set(hits.map((d) => d.topic));
  const missingTopics = topics.filter((t) => !hitTopics.has(t));

  const sections: string[] = [];
  const patternsSection = renderPatternsSection(matchedPatterns);
  if (patternsSection) sections.push(patternsSection);
  const memorySection = renderMemorySection(hits);
  if (memorySection) sections.push(memorySection);
  sections.push(`## User request\n${input.description}`);
  if (answers.length > 0) {
    sections.push(`## Clarification answers\n${answers.map((a) => `- ${a}`).join("\n")}`);
  }

  return {
    prompt: { staticPrefix: STATIC_PREFIX, volatileSuffix: sections.join("\n\n") },
    matchedPatterns,
    memoryHits,
    missingTopics,
  };
}
