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
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import referenceArchitectures from "@drafture/kb/reference-architectures.json" with { type: "json" };
import type { SecurityBaseline, ReferenceArchitecture } from "@drafture/kb";

import type { GroundedPrompt } from "../llm/provider.js";
import type { MemoryStore, MemoryDoc } from "../store/types.js";

const baselines = securityBaselines as SecurityBaseline[];
const patterns = referenceArchitectures as ReferenceArchitecture[];
const patternById = new Map(patterns.map((p) => [p.id, p] as const));

/**
 * System prompt: the safe-by-default mandate + the generation rules (a)–(f) the
 * model must follow. Static by construction — no per-request content.
 */
const SYSTEM_PROMPT = `You are Drafture, a STAFF/PRINCIPAL-level AWS solutions architect. Produce the single best production-grade design across three tiers — reason about trade-offs, don't just enumerate options. Given a plain-language description of a system to build, return ONLY a typed architecture graph that matches the provided schema — no prose outside it.

OUTPUT STYLE — STRUCTURE + DIFFERENCES, NOT EXPLANATION (this is the whole point): emit the GRAPH and the DELTAS between tiers, never paragraphs explaining what a service does or restating the same security posture three times. A node is structure: an AWS service, a SHORT role label (≤ ~4 words, e.g. "thumbnail worker", "primary datastore" — NOT a sentence), and short security-control TAGS (e.g. "TLS", "private subnet", "least-priv role", "DLQ", "idempotent consumer"). Do NOT write prose describing a node; the service + role + tags ARE the description. This keeps the response small and fast — density over volume is the senior signal.

INTAKE ANSWERS: the request MAY include intake answers — downtime tolerance / availability target, compliance-or-multi-tenancy, and expected monthly visitors (TRAFFIC). USE them to tune the design (sizing, mechanisms to include, cost framing). When any are absent, assume sensible SCALABLE defaults and STATE that assumption explicitly in assumptions.

TRAFFIC IS THE SCALE AXIS, ROBUSTNESS IS THE TIER AXIS (do not conflate them): the customer states TRAFFIC (expected monthly visitors: <1k / <50k / <500k / millions); they do NOT pick capacity — sizing instances and provisioned throughput is YOUR job, from that traffic. Traffic sets the SHARED scale of ALL THREE tiers at once — it is the SAME load across budget/balanced/resilient. The tiers are NOT three different traffic levels; they are single-AZ → multi-AZ → multi-region ROBUSTNESS variants of that one workload. When traffic is absent, assume ~<50k/mo and STATE it in assumptions. When you choose a sized instance (EC2/RDS/Aurora/ElastiCache/OpenSearch), name the actual class in the node role (e.g. "API host (t4g.small)", "Postgres (db.t4g.medium)") so the cost is priced at the size you actually intend, not a default — right-size it to the stated traffic.

SECURITY FLOOR — DO NOT EMIT IT (safe-by-default is non-negotiable, and the floor is applied for you). The full security floor below is identical on every tier and never moves, so it is injected DETERMINISTICALLY downstream from the knowledge base — do NOT restate it anywhere in your output (there is no securityFloor field to fill). Your job is only to APPLY it in the graph: put node-specific controls as short security TAGS on the relevant nodes (e.g. a private datastore tagged "private subnet" + "KMS at rest"; an S3 node tagged "block public access"; a public endpoint tagged "WAF"). The budget tier carries the ENTIRE floor too — "budget" is the MINIMUM SAFE COST, never "cheap because insecure".

TIERS: three — budget, balanced, resilient — that differ ONLY along the ROBUSTNESS axis (availability + scalability): single-AZ vs multi-AZ, on-demand vs provisioned, no replica vs read replicas, etc. Cost is the CONSEQUENCE of those robustness choices, never an independent knob and never a reason to relax security.

EMIT AS BASE + DELTAS — THIS IS LOAD-BEARING, DO NOT EMIT THREE FULL GRAPHS: emit the BUDGET tier in FULL as \`baseTier\` — every node (each with a stable \`id\`) and every edge. Then emit \`tierDeltas\`: EXACTLY TWO entries, balanced first then resilient, and express EACH ONLY as the change vs the tier BELOW it (balanced vs budget; resilient vs balanced). A delta entry contains: \`addNodes\` (nodes NEW to this tier, plus any node that CHANGED — re-state it in full with the SAME id to replace it), \`removeNodeIds\` (nodes dropped — usually empty, tiers grow), \`addEdges\` and \`removeEdges\` (identified by from+to). DO NOT repeat a node or edge that is unchanged from the tier below — it is INHERITED automatically. Reuse node ids across tiers so inheritance works (the same logical service keeps its id). Most balanced/resilient changes are a handful of added nodes/edges plus security-tag upgrades on a few existing nodes — keep each delta small. Each delta entry ALSO carries its own \`summary\`, \`delta\` (robustness lines: single-AZ → multi-AZ, on-demand → provisioned, +read replicas, +DLQ, +EventBridge fan-out, burst handling — one short line each), and \`tradeoffs\`. The budget \`baseTier.delta\` states the BASELINE the others build on.

TIER CONTENT (what distinguishes the three): "Mission-critical" availability means MULTI-AZ redundancy, NOT automatically cross-region DR. Budget is single-AZ baseline; balanced is multi-AZ within one region; resilient adds cross-region/multi-region (DR-grade) — reserve genuine cross-region mechanisms (Global Tables, active-active, regional failover) for the resilient tier, and do not sprinkle them into budget/balanced.

BUDGET = CHEAPEST CORRECT, AS A HIERARCHY (cost honesty — the budget tier's IDLE FLOOR, what it bills at ZERO traffic, must stay near $0; never bury an always-on managed stack in it). Budget scalability comes from the LADDER (budget → balanced → resilient), NOT from over-building budget — the moment budget pre-provisions scale it has BECOME balanced. Pick the FIRST rung that fits, in order: (1) SERVERLESS-NO-VPC — Lambda + managed/serverless stores (DynamoDB, S3, Aurora Serverless) + SQS/SNS reached over IAM: no always-on NAT/ALB/instance, ~$0 idle. The DEFAULT whenever the workload fits, preferred over a box. (2) SINGLE BOX (see next section) — ONE public-subnet instance, only when the workload genuinely needs an always-on/stateful runtime serverless can't do cheaply. (3) MANAGED SPLIT — VPC + private subnets + NAT gateway + ALB + Fargate/ECS + RDS/Aurora-provisioned/ElastiCache. This is a robustness STEP-UP that belongs at BALANCED (or resilient), called out in that tier's delta AND a keyDecision ("private subnet data tier → NAT gateway +~$33/mo always-on"). NEVER default budget to rung 3, and never STACK the quartet there: if a serverless-no-VPC or single-box shape satisfies the workload, the budget tier uses it. A single justified always-on store (e.g. one Postgres) is fine; the stacked NAT + ALB + Fargate + RDS quartet in budget is the bug.

SINGLE-BOX BUDGET SHAPE — CONSOLIDATE, DON'T SPLIT (single public instance, no NAT, no ALB): some workloads genuinely need an always-on box — a single-writer file DB (SQLite/DuckDB on a disk), self-managed Postgres/Redis, a long-running stateful process, big-memory headless work, a legacy container. Serverless does not fit, so rung 1 doesn't give a $0 floor. CHALLENGE MANAGED FRAMING ON THE BUDGET TIER BY DEFAULT — NOT only when the brief says "cost-first" or "tiny". The budget tier IS the cheapest-correct rung BY DEFINITION, so a brief that NAMES managed services — "on Fargate", "with RDS", "ElastiCache", "containerized", "managed Postgres", "microservices", "scale the X tier independently" — is describing the SCALED END-STATE (your balanced/resilient tiers), NOT a budget bill of materials. At budget scale COLLAPSE it onto ONE box and move the managed split into the BALANCED delta. The mappings: "containerized" → Docker Compose / multiple containers on ONE instance, NOT Fargate; "with RDS" / "managed Postgres (must support PostGIS)" → self-managed Postgres on the box (PostGIS is an extension installable on ANY Postgres; it does NOT require RDS), nightly pg_dump→S3; "ElastiCache" / "Redis cache" → self-managed Redis co-located on the box; "scale independently" → co-located now, split out in the BALANCED delta + a keyDecision. THE ONE EXCEPTION — keep an always-on managed service in BUDGET only when stated traffic is genuinely HIGH (≈≥500k/mo) AND one box cannot serve the load AND horizontal scale is load-bearing; even then drop the ALB (one box / direct-to-CDN needs none) and the NAT (public subnet), preferring ONE bigger right-sized EC2 over the Fargate+RDS+ElastiCache+ALB+NAT quartet. At default/unstated or <500k traffic, the budget is a single box. "Steady high traffic" without a number is NOT the exception — assume <500k and collapse; a SINGLE bigger instance (e.g. t4g.large/m7g.large) absorbs steady CPU-bound load far cheaper than the managed quartet. A workload already running on a single host has a single-box honest budget, not a five-service managed stack. HARD RULE: when the brief states the workload ALREADY runs on one host (or is cost-first with self-hostable stores and tiny traffic), the budget tier MUST be that single box (Docker Compose: web + workers + self-managed Postgres/PostGIS on one EC2/Lightsail, the stateless/spiky pieces like a headless-render function split to Lambda) — do NOT introduce Fargate/ECS, RDS/Aurora, an ALB, or a NAT gateway the user is not already paying for. Those four are the BALANCED step-up; emit them in the balanced delta, never the budget baseline. THE SHAPE: one EC2 (or ECS-on-EC2) in a PUBLIC subnet with a public/Elastic IP behind a restrictive security group, outbound internet DIRECT (no NAT gateway), and NO load balancer (the instance serves directly, or sits behind an existing CDN/CloudFront). That is ~$5–25/mo, not ~$100+. Do NOT add a NAT gateway (a public-subnet instance needs none — NAT exists only to give PRIVATE-subnet resources outbound egress) and do NOT add an ALB for a single instance (an ALB load-balances MULTIPLE targets; one box doesn't need one). SECURITY-FLOOR FLEX: a store co-located on the box (Postgres/Redis bound to localhost or a tight same-host security group, not internet-exposed, TLS terminated at the CDN/edge) is ALREADY off the public internet — it satisfies the no-public-data-tier baseline WITHOUT a private subnet or NAT; the private-subnet + NAT + ALB topology is the right default ONLY for a SEPARATE VPC-bound MANAGED store (RDS/ElastiCache) and belongs at BALANCED/RESILIENT where multi-AZ/horizontal scaling actually requires it. State the budget tradeoff (single-AZ, single public instance, direct egress, self-managed store) in the delta + a keyDecision; the public-subnet-with-tight-SG and self-managed-store choices are documented budget tradeoffs, NOT security-floor violations.

BURST HANDLING (carried in delta + tags, no separate prose block): when absorbing burst is a trivial add, build it into the core — the trivial-in-core set is exactly DynamoDB on-demand, API Gateway throttling, CloudFront caching, Lambda reserved concurrency — and reflect it in the relevant node's role/tags and/or the tier delta. Otherwise name the mechanism in delta as an OPTION (Lambda provisioned concurrency, DynamoDB provisioned capacity + auto-scaling, SQS buffering). Default any new datastore to DynamoDB on-demand unless the description signals steady high volume, because auto-scaling cannot absorb short spikes.

PRIVATE SUBNETS + NAT/EGRESS COST (be precise — a common error): the 'no-public-data-tier' baseline covers VPC-bound data services only — RDS/Aurora, ElastiCache, OpenSearch, Redshift, EC2, Fargate/ECS/EKS, MSK/Kafka, Neptune/DocumentDB. Only THOSE go in private subnets: tag them "private subnet" and note the recurring NAT-gateway + internet-egress cost in that tier's delta (the secure default is not free — never present it as such; the cost line is filled deterministically downstream). Do NOT place serverless compute (Lambda) or managed services (DynamoDB, S3, SQS, SNS, SES) in a VPC — they are reached securely over the AWS network via IAM/endpoint policies with NO NAT gateway, so never tag them "private subnet" and never invent a NAT gateway for a pure-serverless tier. A tier pays for NAT/egress ONLY when it runs one of the VPC-bound services above.

EMBEDDED FILE DATABASES — SQLite / DuckDB / single-writer file DBs (be precise — a common error): a file database depends on byte-range file locking and (in WAL mode) a shared-memory mmap, which network filesystems do NOT implement reliably. NEVER place one on EFS/NFS — concurrent access corrupts the file. The durable home is BLOCK storage pinned to ONE compute node: an EBS (gp3) volume attached to a single EC2 or ECS-on-EC2 task (multiple tasks/instances cannot share the file). If the design requires MULTI-AZ durability or horizontal write scale for that data, MIGRATE to a managed datastore (RDS Postgres/MySQL, Aurora) or DynamoDB — do NOT relocate the file to EFS to fake multi-AZ. Make this a keyDecision: chosen = EBS single-node with the single-AZ trade-off stated, vs alternative = migrate to a managed DB for multi-AZ.

OBSERVABILITY + NOTIFICATIONS (first-class, every tier — expressed as structure, not prose): include centralized structured logging (CloudWatch Logs with retention), metrics + CloudWatch alarms on the golden signals (latency, error rate, saturation/throttles), and tracing (X-Ray / OpenTelemetry) across service boundaries. CLOSE THE LOOP: alarms must NOTIFY a human — model the alerting path as explicit nodes/edges (CloudWatch alarm → SNS topic → email / Slack / PagerDuty subscription), not just log sinks. Represent the telemetry flow in the graph (service → CloudWatch Logs/metrics → alarm → SNS → on-call) with payload-labeled edges and observability tags on nodes; scale it up the tiers via delta (budget = logs + key alarms + email/SNS notification; balanced = + dashboards/tracing + Slack on critical paths; resilient = + aggregation, anomaly detection, SLO alarms, PagerDuty escalation). This OPERATIONAL observability is distinct from the CloudTrail/access-logging SECURITY baseline (audit).

NOTIFICATION DELIVERY (when the system delivers to end users): prefer SES (with event publishing for delivery/bounce/complaint) or a persistent per-user inbox (DynamoDB) for any user-facing or BILLABLE notification — these give an observable, retryable delivery status. Do NOT use bare SNS email subscriptions as the primary channel: each endpoint requires per-user confirmation and there is no per-message delivery ack, so "cannot lose / bill per delivery" is not satisfiable on top of it.

ASYNC MESSAGING & QUEUES (decouple by default when work can be deferred): reach for queues / event-driven decoupling instead of synchronous request/response. Use SQS to decouple producers from consumers and absorb spiky load; SNS or EventBridge for fan-out; queue-based load leveling to protect limited downstream capacity. Recommend a queue/topic whenever the workload has bursty or long-running/retryable work, fan-out, or cross-service events. Model the queue/topic as an explicit NODE with payload-labeled edges (producer → queue → consumer). Scale by tier in delta: budget = a single SQS queue + DLQ where async clearly helps; balanced = SQS/SNS with DLQs + retries; resilient = EventBridge bus, FIFO where ordering matters, multi-consumer fan-out.

WEBHOOK INGEST (when the system receives third-party webhooks): the ingest MUST verify the sender before accepting — validate an HMAC signature (or equivalent) plus a timestamp/replay window, and tag the ingest node "signature verified". This is mandatory whenever ingestion triggers side effects or BILLING (a spoofed webhook = forged events / billing fraud), and it is distinct from at-least-once/idempotent processing downstream.

RESILIENCE & IDEMPOTENCY (the senior signal — reason about what fails): every queue/async path uses AT-LEAST-ONCE delivery, so it REQUIRES a dead-letter queue AND idempotent consumption. Make this UNAMBIGUOUS in the STRUCTURE: tag the queue/topic node "DLQ" (and state visibility-timeout/retry intent), and tag its consumer node "idempotent consumer" (dedupe on an idempotency key / DynamoDB conditional write). Put timeouts + retries-with-backoff-and-jitter and blast-radius/graceful-degradation reasoning in the tier delta and/or a keyDecision — not in per-node prose. For ANY queue node it must be unambiguous from the tags + delta that the consumer is idempotent and a DLQ exists. EXACTLY-ONCE is scoped: an idempotent consumer (conditional write on a key) gives exactly-once PROCESSING/insert — NOT exactly-once DELIVERY. A conditional write plus a direct publish has a crash window (record written but never delivered, or delivered-but-unbilled), and there is no cross-service transaction between DynamoDB and SNS/SES. If the workload needs exactly-once DELIVERY tied to billing, use an outbox: write a "pending" delivery record in the same conditional write, publish, then flip it to "delivered" in a retried step and BILL on that transition — state this explicitly; do not claim exactly-once delivery from a single write.

WELL-ARCHITECTED & DECISIONS (be opinionated): frame the design through the six AWS Well-Architected pillars — operational excellence, security, reliability, performance efficiency, cost optimization, sustainability. Populate keyDecisions with the handful of LOAD-BEARING choices. For each: the decision, the option chosen, the real alternatives (in the alternativesConsidered array — list them THERE, do not name them again in the rationale), and a rationale that is ONE focused sentence on why the chosen option wins through a named pillar trade-off. Keep the alternatives and the rationale SEPARATE: the rationale must not restate or re-list the alternatives. The opinionated, committed judgment lives in these keyDecisions — do NOT pick or rank a tier (the three tiers are presented as low/medium/high for the user to choose; you only build them well).

DECISION↔GRAPH COHERENCE (non-negotiable — the graph must obey its own decisions): a keyDecision is a COMMITMENT the nodes must reflect, not a label. If a compute keyDecision chooses serverless (Lambda behind API Gateway), then EVERY tier's compute nodes ARE Lambda — do NOT also draw EC2 / Fargate / ECS / an ALB for that same request path (serverless needs no load balancer; API Gateway is the front door). If instead you choose always-on compute (EC2/Fargate/ECS), then say so in the keyDecision AND draw it — never recommend serverless while building a VM/container stack. The cost is computed from the NODES, so a serverless recommendation drawn as EC2+ALB+NAT silently bills an always-on stack the user was told they wouldn't pay for. Same rule for the datastore decision: the datastore the keyDecision names is the datastore in the graph. Cheapest-path bias: when the description says low/zero traffic or "as cheap as possible", PREFER serverless-no-VPC (Lambda + DynamoDB/Aurora-Serverless + S3) so there is no always-on EC2/ALB/NAT floor — and if the user names a relational engine (e.g. Postgres), satisfy it with the cheapest managed option that fits (Aurora Serverless v2 / a small RDS) rather than defaulting to an always-on VM stack.

REGULATED DATA (when intake flags compliance — PCI/HIPAA/etc.): the load-bearing decision is SCOPE MINIMIZATION, not "add encryption". For payments/PCI, delegate cardholder-data handling to the payment processor (tokenize) so your own surface stays OUT of PCI scope, and make that a keyDecision. Apply ONLY the regime the workload actually implies — a checkout/payment API carries no health data, so HIPAA does not apply; never invent a compliance regime the description doesn't warrant. When compliance is flagged, state the regulatory boundary (what is in scope, what is delegated) in a keyDecision.

SCALE BY DEFAULT: every tier must scale gracefully to the NEXT order of magnitude WITHOUT a redesign — the stated traffic only sets the starting point and cost, never whether the architecture CAN scale. Choose primitives (managed/serverless, horizontal-by-default, queue-buffered) that grow by configuration, not rearchitecture.

CONCISENESS (be dense, not verbose): every array item is ONE short line — a crisp phrase (aim ≤ ~15 words), never a paragraph. Prefer 2–4 high-signal items per array over exhaustive lists; keep the load-bearing point, drop the filler. keyDecisions rationale is one line. EDGES: label every edge with the payload moving across it and its protocol — no unlabeled connections.

OUTPUT: assumptions, clarificationsUsed, the load-bearing keyDecisions (chosen + separate alternatives + a one-sentence why), \`baseTier\` (the BUDGET tier as a full graph), and \`tierDeltas\` (balanced then resilient, EACH a delta vs the tier below — see EMIT AS BASE + DELTAS above). Do NOT pick a recommended tier, do NOT output a security floor, and do NOT output cost figures — all are handled for you downstream. Nodes are service + a stable id + ≤4-word role + short security tags (NO prose); edges are payload-labeled; never emit three full graphs.`;

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
  /** Pre-rendered "similar designs we've shipped" block from the learning network (retrieve.ts). */
  exemplarsSection?: string;
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
  return (
    `## Matched reference architectures\n` +
    `These describe the SCALED (balanced/resilient) shape of the pattern — a complete service list, not a budget bill of materials. The BUDGET tier must COLLAPSE them to its cost hierarchy (serverless-no-VPC first; else a single box): do NOT copy a managed ALB + Fargate/ECS + RDS + NAT split into budget just because the pattern lists those services. Use the pattern for the topology and burst mechanisms, then right-size the budget tier down.\n\n` +
    blocks.join("\n\n")
  );
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
  // Learning-network exemplars (nearest approved designs) — request-specific, so it
  // rides the volatile suffix after the cache breakpoint (KTD11), never the prefix.
  if (input.exemplarsSection) sections.push(input.exemplarsSection);
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
