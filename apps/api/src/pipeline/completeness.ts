/**
 * Structural completeness checks (R-completeness) — pure, deterministic, free.
 *
 * Extracted from the golden property suite so the SAME checks gate offline (the
 * eval pass-rate) AND ride the per-generation telemetry line at runtime
 * (`completenessOk`). They matter more since tier-delta emission: balanced/
 * resilient are reconstructed from deltas, so a delta that references a renamed/
 * removed node id would otherwise produce a silently-broken graph. Both are
 * high-confidence (no realistic false positive); `test/golden/properties.ts`
 * imports them so there is one source of truth.
 */
import type { ArchitectureResult } from "../schema/architecture.js";

/** Result shape compatible with the golden suite's `PropertyResult`. */
export interface CompletenessCheck {
  name: "graphHasNoDanglingEdges" | "primaryDatastoreReachable" | "graphHasNoOrphanNodes";
  ok: boolean;
  reason: string;
}

// PRIMARY data stores only (OLTP / cache / search) — deliberately EXCLUDES S3,
// which is often a legitimately-unconnected asset/audit-log sink. A primary store
// with no edge is always an incomplete design (you can't read or write it).
const PRIMARY_DATASTORE_KEYWORDS = [
  "dynamodb", "rds", "aurora", "elasticache", "redis", "memcached",
  "opensearch", "elasticsearch", "documentdb", "neptune", "redshift", "timestream",
] as const;

export function isPrimaryDatastore(awsService: string, role: string): boolean {
  const s = `${awsService} ${role}`.toLowerCase();
  // Word-boundary match, not a bare substring: `includes("rds")` mis-fires on
  // "CloudWatch Dashboa-RDS" / "reco-RDS" / "standa-RDS", flagging a passive dashboard
  // node as an unreachable primary datastore. `\bkw\b` requires the store to appear as
  // its own token ("rds", "aurora", "redis"…) — same fix the cost engine uses.
  return PRIMARY_DATASTORE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(s));
}

// Edge endpoints that name a NON-AWS external dependency — a SaaS the design calls over
// the public internet — are legitimately NOT nodes in this graph (there is no `aws_*`
// resource to emit for them, and the cost is the vendor's, pass-through). The model
// routinely draws e.g. `api -> cloudflare` (edge TLS/CDN) or `api -> anthropic-api` (the
// LLM call) without a node for it, which would otherwise false-fail this check. Exempt a
// curated set of the common ones so the gate fires only on a genuinely-broken INTERNAL
// reference (a typo'd or renamed node id) — never on a real external dependency. If the
// model DOES emit the external as a marker node, the endpoint is a real id and passes
// naturally; this allowlist only covers the bare-endpoint case.
const EXTERNAL_ENDPOINT_KEYWORDS = [
  "cloudflare", "fastly", "akamai",
  "anthropic", "openai", "gemini", "huggingface",
  "stripe", "paypal", "adyen", "braintree",
  "twilio", "sendgrid", "mailgun", "postmark",
  "auth0", "clerk", "okta",
  "google maps", "mapbox",
  "segment", "mixpanel", "amplitude",
  "slack", "github", "gitlab",
] as const;

function isExternalEndpoint(id: string): boolean {
  const s = id.toLowerCase();
  return EXTERNAL_ENDPOINT_KEYWORDS.some((kw) => s.includes(kw));
}

/** Every edge endpoint must be a real node `id` in that tier (or the literal "client",
 *  or a known external SaaS dependency — see {@link isExternalEndpoint}). A dangling
 *  INTERNAL edge is always a bug, and the canonical failure mode of a bad tier-delta
 *  (an addEdge referencing a node id that was renamed or removed). */
export function graphHasNoDanglingEdges(result: ArchitectureResult): CompletenessCheck {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const ids = new Set(tier.nodes.map((n) => n.id));
    ids.add("client");
    tier.edges.forEach((e, i) => {
      if (!ids.has(e.from) && !isExternalEndpoint(e.from))
        offenders.push(`${tier.name}:edge[${i}] from unknown '${e.from}'`);
      if (!ids.has(e.to) && !isExternalEndpoint(e.to))
        offenders.push(`${tier.name}:edge[${i}] to unknown '${e.to}'`);
    });
  }
  return {
    name: "graphHasNoDanglingEdges",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every edge references a real node" : offenders.join("; "),
  };
}

/** A primary datastore (DynamoDB/RDS/Aurora/cache/search) must be touched by at
 *  least one edge — an unwired primary store is an incomplete design. */
export function primaryDatastoreReachable(result: ArchitectureResult): CompletenessCheck {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const wired = new Set<string>();
    for (const e of tier.edges) {
      wired.add(e.from);
      wired.add(e.to);
    }
    for (const n of tier.nodes) {
      if (isPrimaryDatastore(n.awsService, n.role) && !wired.has(n.id)) {
        offenders.push(`${tier.name}: datastore '${n.id}' (${n.awsService}) has no edge`);
      }
    }
  }
  return {
    name: "primaryDatastoreReachable",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every primary datastore is wired into the graph" : offenders.join("; "),
  };
}

// An unwired node is usually a bug (a delta added it but never connected it), but a
// few service kinds are LEGITIMATELY edgeless sinks: passive asset stores and the
// audit/log destinations the security floor requires (S3 assets, CloudWatch Logs,
// CloudTrail, Config), plus passive observability / build / protection / egress
// surfaces that ATTACH rather than sit in the data flow. Exempt those so the check
// fires only on genuinely-orphaned active nodes (a stray compute, queue, or primary
// datastore left dangling — the canonical tier-delta reconstruction failure).
const ORPHAN_EXEMPT_KEYWORDS = [
  "s3", "cloudwatch logs", "cloudwatch log", "cloudtrail", "aws config", "log group",
  "access log", "audit", "flow log",
  // Passive OBSERVABILITY surfaces — edgeless by nature, like CloudWatch Logs:
  // X-Ray traces instrument services in-process, so they carry no graph edge.
  "x-ray", "xray",
  // Passive build/deploy INFRA — an image registry that compute pulls from at task
  // launch, not a runtime data-flow participant (present in every container design).
  "ecr", "elastic container registry", "container registry",
  // Passive SECRETS/CONFIG stores — SSM Parameter Store / Secrets Manager are pulled at
  // launch (or call-time) by compute, not runtime data-flow endpoints. Models correctly
  // draw them as nodes but (rightly) don't wire them as data-flow hops, so an edgeless one
  // is legitimate — same call ECR/NAT/WAF make.
  "ssm", "parameter store", "secrets manager",
  // Passive PROTECTION LAYERS — a web ACL / DDoS subscription ATTACHES to CloudFront/
  // ALB/Route 53 rather than sitting in the data flow. The security floor REQUIRES edge
  // protection, so it's present in most designs; models wire it inconsistently, which
  // made the gate false-fail honest designs. Edgeless here is legitimate.
  "waf", "shield",
  // Passive EGRESS INFRA — a NAT gateway gives private-subnet resources outbound egress;
  // it is not a data-flow endpoint (the cost engine already models it as a synthetic line,
  // not a graph hop). Multi-word key so the bare token "nat" can't collide.
  "nat gateway",
] as const;

function isOrphanExempt(awsService: string, role: string): boolean {
  const s = `${awsService} ${role}`.toLowerCase();
  if (ORPHAN_EXEMPT_KEYWORDS.some((kw) => s.includes(kw))) return true;
  // A CloudWatch Dashboard is a passive metric-viz surface (edgeless like a log
  // group), whichever word holds "dashboard". Require BOTH tokens so a bare
  // user-facing "dashboard" (a UI node that SHOULD be wired) is never exempted.
  if (s.includes("cloudwatch") && s.includes("dashboard")) return true;
  return false;
}

/** Every node must participate in at least one edge — an unwired active node is
 *  the canonical failure mode of a tier-delta that ADDS a node but never wires it.
 *  Passive asset/audit-log sinks (and the other exempt surfaces above) are exempt:
 *  they are legitimately edgeless in the graph, the same exclusion
 *  `primaryDatastoreReachable` makes for S3. */
export function graphHasNoOrphanNodes(result: ArchitectureResult): CompletenessCheck {
  const offenders: string[] = [];
  for (const tier of result.tiers) {
    const wired = new Set<string>();
    for (const e of tier.edges) {
      wired.add(e.from);
      wired.add(e.to);
    }
    for (const n of tier.nodes) {
      if (!wired.has(n.id) && !isOrphanExempt(n.awsService, n.role)) {
        offenders.push(`${tier.name}: node '${n.id}' (${n.awsService}) has no edge`);
      }
    }
  }
  return {
    name: "graphHasNoOrphanNodes",
    ok: offenders.length === 0,
    reason: offenders.length === 0 ? "every active node is wired into the graph" : offenders.join("; "),
  };
}

/** The structural-completeness checks that gate a well-formed graph, in order. Pure
 *  and $0 — the same logic the offline golden suite asserts, now also computable on
 *  the live path so the runtime telemetry can MEASURE (not just assert offline) how
 *  often a generation ships a malformed graph. */
const STRUCTURAL_CHECKS: ReadonlyArray<(result: ArchitectureResult) => CompletenessCheck> = [
  graphHasNoDanglingEdges,
  primaryDatastoreReachable,
  graphHasNoOrphanNodes,
];

/** Names of every structural-completeness check that FAILS on this design — the
 *  diagnostic detail behind {@link isStructurallyComplete}. Empty when the graph is
 *  well-formed. The live generation path emits this on the telemetry line
 *  (`gateFailures`) so a broken graph is observable per-request, root-caused by
 *  check name (esp. orphaned tier-delta replica/DR nodes). */
export function structuralFailures(result: ArchitectureResult): string[] {
  return STRUCTURAL_CHECKS.map((check) => check(result)).filter((c) => !c.ok).map((c) => c.name);
}

/** True iff a design passes every structural-completeness check — the boolean the
 *  runtime telemetry line reports (`completenessOk`). Includes orphan detection: an
 *  unwired active node is an incomplete design, not just a cosmetic smell. */
export function isStructurallyComplete(result: ArchitectureResult): boolean {
  return structuralFailures(result).length === 0;
}
