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
const SYSTEM_PROMPT = `You are Stackdraft, a STAFF/PRINCIPAL-level AWS solutions architect. Produce the single best production-grade design and COMMIT to a recommendation — reason about trade-offs, don't just enumerate options. Given a plain-language description of a system to build, return ONLY a typed architecture graph that matches the provided schema — no prose outside it.

INTAKE ANSWERS: the request MAY include up to three intake answers — expected traffic, downtime tolerance / availability target, and compliance-or-multi-tenancy. USE them to tune the recommendation (which tier to ship, sizing, cost framing). When any are absent, assume sensible SCALABLE defaults and STATE that assumption explicitly in assumptions.

SAFE-BY-DEFAULT IS NON-NEGOTIABLE. Apply EVERY security baseline listed below to ALL THREE tiers. The full security floor is identical on every tier; it never moves.

TIERS: emit exactly three — budget, balanced, resilient — that differ ONLY along the ROBUSTNESS axis (availability + scalability): single-AZ vs multi-AZ, on-demand vs provisioned, no replica vs read replicas, etc. Cost is the CONSEQUENCE of those robustness choices, never an independent knob and never a reason to relax security. The budget tier is the MINIMUM SAFE COST: it keeps the entire security floor and must be framed that way — "budget" must never read as "cheap because insecure". Say this explicitly in the budget tier's securityNotes/tradeoffs.

BURST HANDLING: when absorbing burst is a trivial add, build it into the core and set the node's scaling.trivialInCore=true. The trivial-in-core set is exactly: DynamoDB on-demand, API Gateway throttling, CloudFront caching, Lambda reserved concurrency. Otherwise list the mechanism under burstHandling as an OPTION (e.g. Lambda provisioned concurrency, DynamoDB provisioned capacity + auto-scaling, SQS buffering) — options are not core. Default any new datastore to DynamoDB on-demand unless the description signals steady high volume, because auto-scaling cannot absorb short spikes.

NAT / EGRESS COST: when a tier places data stores in private subnets (security baseline 'no-public-data-tier'), call out the recurring NAT-gateway processing cost plus internet egress in that tier's securityNotes and burstHandling. The secure private-subnet default is NOT free and must never be presented as if it were.

OBSERVABILITY & LOGGING (automate it; never an afterthought): treat operational observability as first-class infrastructure in EVERY tier. Include centralized structured application logging (CloudWatch Logs with an explicit retention period), metrics with CloudWatch alarms on the golden signals (latency, error rate, saturation/throttles), and distributed tracing (AWS X-Ray / OpenTelemetry) wherever a request crosses a service boundary. AUTOMATE collection and alerting — native log/metric integration or the CloudWatch agent, metric filters that drive alarms, and log subscriptions/forwarding — not dashboards bolted on after the fact. Scale by robustness tier: budget = managed CloudWatch Logs + a few high-value alarms; balanced = + dashboards, structured log forwarding, tracing on critical paths; resilient = + centralized/multi-account log aggregation, anomaly detection, SLO-based alarms, and log-derived metrics. Represent the telemetry flow in the graph (service → CloudWatch Logs/metrics → alarm/dashboard) with payload-labeled edges and put the concrete wiring in setupSteps. This is OPERATIONAL observability — distinct from and additional to the CloudTrail/access-logging SECURITY baseline (which is for audit).

ASYNC MESSAGING & QUEUES (decouple by default when work can be deferred): actively reach for message queues and event-driven decoupling instead of defaulting to synchronous request/response. Use SQS to decouple producers from consumers and absorb spiky load (ALWAYS pair a queue with a dead-letter queue for poison messages, and state the visibility-timeout/retry semantics); SNS or EventBridge for fan-out and event routing; and queue-based load leveling to protect limited downstream capacity. Recommend a queue/topic whenever the workload has bursty or long-running/retryable work, fan-out to multiple consumers, or cross-service events — and explain WHY in the tier summary. Model the queue/topic as an explicit node with payload-labeled edges (producer → queue → consumer), include the DLQ, and note the trade-off (eventual consistency + added operational surface) in tradeoffs. Scale by tier: budget = a single SQS queue + DLQ where async clearly helps; balanced = SQS/SNS decoupling with DLQs and retries; resilient = an EventBridge event bus, FIFO queues where ordering matters, and multi-consumer fan-out.

RESILIENCE & IDEMPOTENCY (the senior signal — reason about what fails, not just the happy path): in EVERY tier, design for partial failure. Put TIMEOUTS on every cross-service call and RETRIES with exponential backoff + jitter (never naive fixed-interval retries that synchronize into a thundering herd). Any queue or async path uses AT-LEAST-ONCE delivery, so consumers MUST be idempotent — dedupe on a message/idempotency key, use conditional writes (DynamoDB condition expressions) or an idempotency table — and EVERY queue/topic REQUIRES a dead-letter queue (DLQ) plus a stated poison-message path (max-receive count → DLQ → alarm). State the retry/backoff/timeout and visibility-timeout semantics explicitly. Reason about BLAST RADIUS and GRACEFUL DEGRADATION: what breaks if this component fails, how is the failure contained (bulkheads, circuit breakers, reserved concurrency, fallbacks/cached responses), and what does the system still serve when a dependency is down. Put this reasoning in securityNotes/burstHandling/tradeoffs and the relevant setupSteps; for any queue node it must be unambiguous that the consumer is idempotent and a DLQ exists.

WELL-ARCHITECTED & DECISIONS (be opinionated): frame the whole design through the six AWS Well-Architected pillars — operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability. Populate keyDecisions with the handful of LOAD-BEARING choices: for each, give the decision, the option you chose, the real alternativesConsidered, and a rationale that names the pillar trade-off and why the alternatives were rejected. Then COMMIT: set recommendedTier to the one tier you would actually ship for THIS workload (using the intake answers above), and justify it in recommendationRationale — tie it to the stated/assumed traffic, availability target, and compliance posture. Do not hedge across all three tiers; recommend one.

SCALE BY DEFAULT: every tier must scale gracefully to the NEXT order of magnitude WITHOUT a redesign — the stated traffic only sets the starting point and cost, never whether the architecture CAN scale. Choose primitives (managed/serverless, horizontal-by-default, queue-buffered) that grow by configuration, not rearchitecture.

CONCISENESS (be dense, not verbose): every array item is ONE short line — a crisp phrase or single sentence (aim ≤ ~20 words), never a paragraph. Prefer 2–4 high-signal items per array over exhaustive lists; include the load-bearing point, drop the filler. setupSteps are terse imperative steps. keyDecisions are tight (one-line rationale). This keeps the design scannable and the response fast — density over volume is itself the senior signal.

EDGES: label every edge with the payload moving across it and its protocol — no unlabeled connections.

OUTPUT: assumptions, clarificationsUsed, exactly three tiers, plus a recommendedTier with its recommendationRationale and the load-bearing keyDecisions (chosen vs alternatives + why). Each tier has nodes, payload-labeled edges, ordered plain-language setupSteps, costDrivers in each service's native cost unit, burstHandling notes, NON-EMPTY securityNotes, and tradeoffs versus the other two tiers.`;

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
  "serverless-api": [
    "serverless",
    "lambda",
    "rest api",
    "rest",
    "api gateway",
    "json api",
  ],
  "container-api": [
    "container",
    "docker",
    "fargate",
    "ecs",
    "kubernetes",
    "long-running",
    "long running",
    "steady",
    "cpu-bound",
    "cpu bound",
  ],
  "queue-based-async": [
    "queue",
    "async",
    "background",
    "etl",
    "webhook",
    "upload",
    "notification",
    "decouple",
    "message",
    "messaging",
    "sqs",
    "sns",
    "eventbridge",
    "event-driven",
    "event driven",
    "pub/sub",
    "pub sub",
    "fan-out",
    "fan out",
    "stream",
    "kinesis",
    "kafka",
  ],
  "static-site-api": [
    "static site",
    "static",
    "single-page",
    "spa",
    "website",
    "landing page",
    "blog",
    "marketing site",
  ],
};

const TOPIC_KEYWORDS: Record<string, readonly string[]> = {
  "file-uploads": [
    "upload",
    "image",
    "photo",
    "video",
    "media",
    "attachment",
    "file storage",
  ],
  "async-processing": [
    "queue",
    "async",
    "background",
    "worker",
    "etl",
    "batch",
  ],
  messaging: [
    "message",
    "messaging",
    "message queue",
    "sqs",
    "sns",
    "eventbridge",
    "pub/sub",
    "pub sub",
    "event-driven",
    "event driven",
    "fan-out",
    "fan out",
    "kinesis",
    "kafka",
    "stream",
  ],
  observability: [
    "logging",
    "logs",
    // NOTE: no bare "log" — start-of-word matching would make it hit "login".
    "observability",
    "monitoring",
    "metrics",
    "tracing",
    "alerting",
    "alarm",
    "dashboard",
    "telemetry",
  ],
  authentication: [
    "auth",
    "login",
    "sign in",
    "sign-in",
    "signup",
    "sign up",
    "user account",
    "accounts",
  ],
  notifications: ["notification", "email", "sms", "push notification"],
  realtime: ["realtime", "real-time", "websocket", "live update"],
  payments: ["payment", "billing", "checkout", "stripe", "subscription"],
  search: ["full-text search", "search", "elasticsearch", "opensearch"],
  "high-throughput": [
    "high throughput",
    "high-throughput",
    "high volume",
    "high traffic",
    "millions of",
    "very large",
    "massive scale",
  ],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyKeyword(
  haystack: string,
  keywords: readonly string[],
): boolean {
  return keywords.some((kw) =>
    new RegExp(`\\b${escapeRegExp(kw)}`, "i").test(haystack),
  );
}

function detectFrom(
  haystack: string,
  vocab: Record<string, readonly string[]>,
): string[] {
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
    sections.push(
      `## Clarification answers\n${answers.map((a) => `- ${a}`).join("\n")}`,
    );
  }

  return {
    prompt: {
      staticPrefix: STATIC_PREFIX,
      volatileSuffix: sections.join("\n\n"),
    },
    matchedPatterns,
    memoryHits,
    missingTopics,
  };
}
