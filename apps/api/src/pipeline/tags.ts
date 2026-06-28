/**
 * Deterministic facet tagging of a generated design — the SAME "move correctness out
 * of model whim into code" pattern as the cost engine and the security floor. The
 * model never emits tags; they are derived from the structured body (services present,
 * tier, trade-offs), so tagging is free, instant, reproducible, and works retroactively
 * on the curated seeds. The service→facet map lives here as plain data so adding a
 * service is a one-line edit; a retag pass rewrites all stored tags when it changes.
 *
 * Facets are browse filters for the gallery, not a fine ontology: broad buckets
 * (compute, data, messaging, api, security, robustness, realtime, observability) that
 * a visitor scans quickly. A service may map to several facets (Kinesis = messaging +
 * realtime); a design's tags are the union over its tiers.
 */
interface TaggableDesign {
  recommendedTier?: string;
  tiers?: Array<{
    name?: string;
    nodes?: Array<{ awsService?: string; security?: string[] }>;
    delta?: string[];
    tradeoffs?: string[];
  }>;
}

/**
 * Canonical lowercase service token -> facets. Keys are matched as substrings against
 * the normalized `awsService` string, so "Amazon API Gateway", "API Gateway", and
 * "apigateway" all resolve. Keys are specific enough that substring false-positives
 * across real AWS service names are negligible.
 */
export const SERVICE_CATEGORIES: Record<string, string[]> = {
  // Compute / hosting
  lambda: ["compute"],
  fargate: ["compute"],
  ecs: ["compute"],
  eks: ["compute"],
  ec2: ["compute"],
  "elastic beanstalk": ["compute"],
  "app runner": ["compute"],
  batch: ["compute"],
  lightsail: ["compute"],

  // Data / storage
  dynamodb: ["data"],
  rds: ["data"],
  aurora: ["data"],
  elasticache: ["data", "realtime"],
  redis: ["data", "realtime"],
  s3: ["data"],
  opensearch: ["data"],
  documentdb: ["data"],
  neptune: ["data"],
  timestream: ["data"],
  dax: ["data", "realtime"],
  efs: ["data"],
  "glacier": ["data"],

  // Messaging / async
  sns: ["messaging"],
  sqs: ["messaging"],
  eventbridge: ["messaging"],
  kinesis: ["messaging", "realtime"],
  "step functions": ["messaging"],
  msk: ["messaging", "realtime"],
  kafka: ["messaging", "realtime"],
  mq: ["messaging"],
  ses: ["messaging"],
  pinpoint: ["messaging"],
  firehose: ["messaging"],

  // API / edge
  "api gateway": ["api"],
  appsync: ["api"],
  cloudfront: ["api"],
  "load balancer": ["api"],
  "alb": ["api"],
  "nlb": ["api"],
  "route 53": ["api"],
  "lambda@edge": ["api", "compute"],

  // Security / identity
  kms: ["security"],
  waf: ["security"],
  shield: ["security"],
  guardduty: ["security"],
  "secrets manager": ["security"],
  "parameter store": ["security"],
  cognito: ["security"],
  "certificate manager": ["security"],
  acm: ["security"],
  macie: ["security"],
  inspector: ["security"],

  // Observability
  cloudwatch: ["observability"],
  "x-ray": ["observability"],
  cloudtrail: ["observability", "security"],

  // Realtime / streaming
  iot: ["realtime"],
  websocket: ["realtime"],
};

/** Signals in tier delta/tradeoff text that a design earns the `robustness` facet. */
const ROBUSTNESS_KEYWORDS = [
  "multi-az",
  "multi region",
  "multi-region",
  "failover",
  "fail-over",
  "disaster recovery",
  "read replica",
  "replica",
  "autoscal",
  "auto-scal",
  "standby",
  "high availability",
  "active-active",
  "active-passive",
];

/** The full facet vocabulary, in display order. */
export const FACETS = [
  "compute",
  "data",
  "messaging",
  "api",
  "realtime",
  "security",
  "robustness",
  "observability",
] as const;

/** Strip vendor noise so "Amazon API Gateway" / "AWS Lambda" match their keys. */
function normalizeService(s: string): string {
  return s
    .toLowerCase()
    .replace(/\baws\b/g, "")
    .replace(/\bamazon\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive the facet tags for a design from its structured body. Pure and defensive —
 * a malformed/legacy body yields whatever facets it can, never throws. Returns the
 * sorted unique facet list.
 */
export function tagDesign(design: TaggableDesign): string[] {
  const facets = new Set<string>();
  const robustText: string[] = [];
  let anyNodeSecurityTag = false;

  for (const tier of design.tiers ?? []) {
    for (const node of tier.nodes ?? []) {
      const svc = normalizeService(node.awsService ?? "");
      if (svc) {
        for (const [key, cats] of Object.entries(SERVICE_CATEGORIES)) {
          if (svc.includes(key)) cats.forEach((c) => facets.add(c));
        }
      }
      if ((node.security ?? []).length > 0) anyNodeSecurityTag = true;
    }
    for (const d of tier.delta ?? []) robustText.push(d.toLowerCase());
    for (const t of tier.tradeoffs ?? []) robustText.push(t.toLowerCase());
  }

  // Robustness: an opinionated resilient recommendation, or explicit HA language.
  if (
    design.recommendedTier === "resilient" ||
    robustText.some((t) => ROBUSTNESS_KEYWORDS.some((kw) => t.includes(kw)))
  ) {
    facets.add("robustness");
  }

  // Security: dedicated security services OR nodes carrying security control tags.
  if (facets.has("security") || anyNodeSecurityTag) facets.add("security");

  return Array.from(facets).sort();
}
