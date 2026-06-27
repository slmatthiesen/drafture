/**
 * Deterministic post-generation cleanup of the model's architecture graph.
 *
 * The system prompt tells the model NOT to tag managed/serverless services
 * (Lambda, DynamoDB, S3, SQS, SNS, SES, API Gateway, CloudFront, …) with
 * "private subnet" — those are reached over the AWS network via IAM/endpoint
 * policies and never live in a VPC, so the tag is factually wrong and undermines
 * the staff-architect signal. Models comply inconsistently, so we enforce it
 * deterministically: strip "private subnet" from any node that is NOT a genuinely
 * VPC-bound service. VPC-bound services (RDS, ElastiCache, EC2, Fargate, …) keep
 * the tag, reusing the SAME keyword list the cost engine uses to decide NAT
 * billing (cost.ts `VPC_PRIVATE_SERVICE_KEYWORDS`), so the two never disagree on
 * what "VPC-bound" means.
 *
 * Same "move correctness out of model whim into code" pattern as the injected
 * security floor (see securityFloor.ts).
 */
import type { ArchitectureNode, GeneratedArchitecture, GeneratedTier } from "../schema/architecture.js";
import { VPC_PRIVATE_SERVICE_KEYWORDS } from "./cost.js";

/** Matches the "private subnet" tag in any casing/plurality. */
const PRIVATE_SUBNET_TAG = /private subnet/i;

/**
 * A node is VPC-bound (may legitimately carry "private subnet") if its service or
 * role names one of the VPC-bound services. Mirrors cost.ts `egressesFromPrivateSubnet`
 * so the sanitizer and the cost engine agree.
 */
function isVpcBoundNode(node: ArchitectureNode): boolean {
  const surface = `${node.awsService} ${node.role}`.toLowerCase();
  return VPC_PRIVATE_SERVICE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(surface));
}

function sanitizeNode(node: ArchitectureNode): ArchitectureNode {
  if (isVpcBoundNode(node)) return node;
  const security = node.security.filter((tag) => !PRIVATE_SUBNET_TAG.test(tag));
  // Preserve referential identity when nothing changed (cheap no-op fast path).
  return security.length === node.security.length ? node : { ...node, security };
}

function sanitizeTier(tier: GeneratedTier): GeneratedTier {
  const nodes = tier.nodes.map(sanitizeNode);
  return nodes.every((n, i) => n === tier.nodes[i]) ? tier : { ...tier, nodes };
}

/**
 * Strip the factually-wrong "private subnet" tag from non-VPC services. Pure —
 * returns a new object, input is not mutated. Idempotent.
 */
export function sanitizeGenerated(g: GeneratedArchitecture): GeneratedArchitecture {
  const tiers = g.tiers.map(sanitizeTier);
  return tiers.every((t, i) => t === g.tiers[i]) ? g : { ...g, tiers };
}
