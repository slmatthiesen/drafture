/**
 * Normalize a node's free-text `awsService` (and `role`) into a stable
 * `ServiceKey` — the registry lookup key for an emitter. The model writes the
 * service a hundred ways ("Lambda (arm64, 2048 MB)", "AWS Secrets Manager",
 * "Self-managed PostgreSQL + PostGIS"), so this collapses the surface variety to a
 * small closed vocabulary the emitters key off. Unknown services map to
 * `"unsupported"` and fall to the LLM hybrid fallback in the assembler.
 *
 * Matching is keyword-based and ORDER-SENSITIVE: the most specific patterns are
 * checked first (a "self-managed postgres" must not be mis-read as a managed RDS;
 * "EventBridge Scheduler" is a clock, not the EventBridge bus).
 *
 * Crucially the match runs against `awsService` ONLY, never the role prose: a
 * Lambda whose role reads "nightly pg_dump scheduler" is a Lambda, not the
 * EventBridge Scheduler — letting role text vote would misroute it and the node
 * would silently emit nothing. `awsService` is the structural field; role is a
 * human label.
 */
import type { ArchitectureNode } from "../../schema/architecture.js";

export type ServiceKey =
  | "cloudfront"
  | "s3"
  | "ec2"
  | "postgres-selfmanaged"
  | "lambda"
  | "eventbridge-scheduler"
  | "secrets-manager"
  | "cloudwatch-logs"
  | "cloudwatch-alarms"
  | "sns"
  | "xray"
  | "cloudtrail"
  | "unsupported";

interface Rule {
  key: ServiceKey;
  /** ALL of these (lowercased) must appear in `awsService`. */
  all?: string[];
  /** ANY of these matches. */
  any?: string[];
}

// Order matters — first match wins, most-specific first. Matched against
// `awsService` ONLY. The `self-managed` requirement on postgres is what keeps a
// managed "RDS PostgreSQL" out (it has no emitter — routes to the LLM fallback).
const RULES: Rule[] = [
  { key: "postgres-selfmanaged", all: ["postgres"], any: ["self-managed", "self managed"] },
  { key: "eventbridge-scheduler", any: ["eventbridge scheduler", "scheduler"] },
  { key: "cloudwatch-alarms", any: ["cloudwatch alarm", "metric alarm", "alarms"] },
  { key: "cloudwatch-logs", any: ["cloudwatch logs", "cloudwatch log", "log group"] },
  { key: "cloudtrail", any: ["cloudtrail"] },
  { key: "secrets-manager", any: ["secrets manager", "secretsmanager"] },
  { key: "xray", any: ["x-ray", "xray"] },
  { key: "sns", any: ["sns", "simple notification"] },
  { key: "cloudfront", any: ["cloudfront", "cdn"] },
  { key: "lambda", any: ["lambda"] },
  { key: "s3", any: ["s3", "simple storage"] },
  { key: "ec2", any: ["ec2", "elastic compute"] },
];

export function normalizeServiceKey(node: Pick<ArchitectureNode, "awsService" | "role">): ServiceKey {
  const svc = node.awsService.toLowerCase();
  for (const rule of RULES) {
    const allOk = !rule.all || rule.all.every((kw) => svc.includes(kw));
    const anyOk = !rule.any || rule.any.some((kw) => svc.includes(kw));
    if (allOk && anyOk) return rule.key;
  }
  return "unsupported";
}

/** Compute nodes carry an IAM role + (least-priv) edge-derived policy. */
export const COMPUTE_KEYS: ReadonlySet<ServiceKey> = new Set<ServiceKey>(["ec2", "lambda"]);

/** Keys whose nodes are co-located ON an EC2 box (no network resource of their own). */
export const COLOCATED_KEYS: ReadonlySet<ServiceKey> = new Set<ServiceKey>(["postgres-selfmanaged"]);
