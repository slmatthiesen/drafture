/**
 * The tiered security floor as DATA, not prose (docs/plans/2026-06-30-005).
 *
 * "Budget = cheapest CORRECT." The FREE structural baselines apply at every tier;
 * each PAID enhancement (WAF web ACL, customer-managed CMK, Secrets Manager
 * rotation, multi-region trail) rides the SAME robustness ladder as NAT/ALB/
 * multi-AZ — it enters at its `tierFloor` (balanced or resilient), NOT in budget.
 *
 * THE ONE OVERRIDE: when intake flags regulated/sensitive data, an enhancement
 * with `escalatesUnderCompliance` is pulled DOWN into budget — because budget is
 * cheapest *correct*, and regulated data makes the paid control correct-required.
 *
 * This single module is the source of truth that the prompt, the emitter, the cost
 * engine, and the gate all read, so the deployed infra, the cost table, and the
 * pass/fail verdict can never disagree about what budget carries.
 */
import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import type { SecurityBaseline, SecurityEnhancement } from "@drafture/kb";

import type {
  ArchitectureNode,
  CostDriver,
  KeyDecision,
  Tier,
  TierName,
} from "../schema/architecture.js";

const baselines = securityBaselines as SecurityBaseline[];

/** Local $/mo range formatter — kept here (not imported from cost.ts) so cost.ts can
 *  import this module's `securityFloorCostDrivers` without a circular dependency. The
 *  enhancement costs are whole/sub-dollar fixed amounts, so 2 decimals reads cleanly. */
function fixedRange(low: number, high: number): string {
  return `$${low.toFixed(2)}–$${high.toFixed(2)}/mo`;
}

const TIER_RANK: Record<TierName, number> = { budget: 0, balanced: 1, resilient: 2 };

/** Every paid enhancement across the floor, tagged with the baseline it hardens. */
export interface FloorEnhancement extends SecurityEnhancement {
  baselineId: string;
}

export const FLOOR_ENHANCEMENTS: readonly FloorEnhancement[] = baselines.flatMap((b) =>
  (b.enhancements ?? []).map((e) => ({ ...e, baselineId: b.id })),
);

const enhancementById = new Map(FLOOR_ENHANCEMENTS.map((e) => [e.id, e] as const));

/**
 * Is a paid enhancement active on this tier? True when the tier has climbed to the
 * enhancement's rung, OR the design is compliance-flagged and this control escalates
 * under compliance (pulled into budget). The ONE switch behind WAF, customer CMKs,
 * Secrets-Manager rotation, and the multi-region trail — emitter and cost engine
 * both read it, so they stay in lock-step.
 */
export function enhancementActive(
  enh: SecurityEnhancement,
  tierName: TierName,
  compliance: boolean,
): boolean {
  if (TIER_RANK[tierName] >= TIER_RANK[enh.tierFloor]) return true;
  return compliance && enh.escalatesUnderCompliance;
}

/** Emitter helper: is the enhancement with this id active on (tier, compliance)? An
 *  unknown id is never active (defensive — a renamed enhancement fails closed). */
export function isEnhancementActive(id: string, tierName: TierName, compliance: boolean): boolean {
  const enh = enhancementById.get(id);
  return enh ? enhancementActive(enh, tierName, compliance) : false;
}

/** WAF / customer-CMK / Secrets-Manager-rotation share one rung (balanced, or budget
 *  under compliance). The emitter's single boolean for "does this tier carry the PAID
 *  security floor". */
export function paidSecurityActive(tierName: TierName, compliance: boolean): boolean {
  return isEnhancementActive("customer-managed-cmk", tierName, compliance);
}

/** The multi-region CloudTrail rung — resilient only, or budget+balanced under compliance. */
export function multiRegionTrailActive(tierName: TierName, compliance: boolean): boolean {
  return isEnhancementActive("multi-region-trail", tierName, compliance);
}

// --- Compliance detection ----------------------------------------------------
//
// Regulated regimes + non-trivial sensitivity (multi-tenant) make the paid floor
// correct-required, so budget carries it. Detected from the design's own surface —
// the intake "Data sensitivity" answer flows into assumptions/keyDecisions, and the
// model tags the data tier with the regime — so no out-of-band flag is needed and
// the gate/emitter read the same signal. Bare "compliance" is intentionally NOT a
// marker (too generic — Well-Architected has a compliance pillar); we require a
// concrete regime or tenant-isolation signal.
const COMPLIANCE_MARKERS = [
  "pci", "hipaa", "hitrust", "gdpr", "ccpa", "fedramp", "soc 2", "soc2",
  "pii", "phi", "cardholder", "regulated data", "regulated",
  "multi-tenant", "multitenant", "tenant isolation", "tenant-isolation",
] as const;

// A marker is suppressed when NEGATED in the preceding window — a none-sensitivity
// design states its posture as "No PCI/HIPAA/regulated data" / "no PII … no HIPAA/PCI
// scope", which would otherwise FALSE-flag it as compliance and (wrongly) keep the
// paid floor in budget. Mirrors the banned-services negation guard in properties.ts.
const COMPLIANCE_NEGATION = /\b(no|not|never|without|non|out of|excluded?|n\/a|none|standard)\b/;

/** Does a single string carry a NON-negated compliance marker? Scans every occurrence
 *  of every marker; a hit counts only if its ~28-char prefix has no negation word. */
function markerHit(s: string): boolean {
  const lower = s.toLowerCase();
  for (const m of COMPLIANCE_MARKERS) {
    let idx = lower.indexOf(m);
    while (idx !== -1) {
      const prefix = lower.slice(Math.max(0, idx - 28), idx);
      if (!COMPLIANCE_NEGATION.test(prefix)) return true;
      idx = lower.indexOf(m, idx + m.length);
    }
  }
  return false;
}

function anyMarker(surfaces: string[]): boolean {
  return surfaces.some(markerHit);
}

/** A single tier's compliance surface: node roles + security tags (where the model
 *  tags the data tier with its regime). Used by the emitter, which only sees a tier. */
export function tierIsComplianceFlagged(tier: Tier): boolean {
  return anyMarker(tier.nodes.flatMap((n) => [n.role, ...n.security]));
}

/** The whole design's compliance surface: assumptions + keyDecisions + every tier's
 *  tags. Structurally typed (only the fields it reads) so it accepts both the
 *  pre-cost {@link ArchitectureBeforeCost} and the full {@link ArchitectureResult}. */
export function isComplianceFlagged(result: {
  assumptions: string[];
  keyDecisions: KeyDecision[];
  tiers: { nodes: ArchitectureNode[] }[];
}): boolean {
  return anyMarker([
    ...result.assumptions,
    ...result.keyDecisions.flatMap((d) => [d.decision, d.chosen, d.rationale, ...d.alternativesConsidered]),
    ...result.tiers.flatMap((t) => t.nodes.flatMap((n) => [n.role, ...n.security])),
  ]);
}

// --- Paid-security cost lines (cost-table honesty, DoD #4) --------------------

/** Human display name for a paid enhancement's cost-driver line. */
const ENHANCEMENT_SERVICE_LABEL: Record<string, string> = {
  "waf-web-acl": "AWS WAF (web ACL)",
  "customer-managed-cmk": "KMS (customer-managed CMKs)",
  "secrets-manager-rotation": "Secrets Manager (rotation)",
  "multi-region-trail": "CloudTrail (multi-region + Flow Logs)",
};

/**
 * The FIXED paid-security cost lines a tier carries, deterministically — so the cost
 * table is honest and budget's idle floor SEES them under compliance. These are floor
 * controls the emitter deploys, not graph nodes, so the node-priced cost engine would
 * otherwise miss them entirely (the "hidden security $" the gate is meant to catch).
 * Costs come from the KB enhancement `monthlyUsd` — the keep/defer ladder is DATA.
 */
export function securityFloorCostDrivers(tierName: TierName, compliance: boolean): CostDriver[] {
  const drivers: CostDriver[] = [];
  for (const enh of FLOOR_ENHANCEMENTS) {
    if (!enhancementActive(enh, tierName, compliance)) continue;
    const [low, high] = enh.monthlyUsd;
    const why = compliance && TIER_RANK[tierName] < TIER_RANK[enh.tierFloor]
      ? `pulled into ${tierName} by the compliance override`
      : `${enh.tierFloor}+ security step-up`;
    drivers.push({
      service: ENHANCEMENT_SERVICE_LABEL[enh.id] ?? enh.id,
      unit: "$/mo (fixed)",
      estimateRange: fixedRange(low, high),
      note: `Fixed security-floor cost (${enh.baselineId}, ${why}). ${enh.summary}`,
    });
  }
  return drivers;
}

// --- Paid-security DETECTION on a generated tier (gate) -----------------------
//
// The gate reads the design GRAPH surface (node service/role/tags + cost-driver
// services) for paid-security markers on the BUDGET tier — the over-build a senior
// reviewer rejects. We distinguish PAID controls from their free counterparts: a WAF
// web ACL (not bare "CloudFront"), a *multi-region* trail (not a single-region one), a
// Secrets Manager SERVICE node (not SSM Parameter Store), an explicitly
// *customer-managed* CMK (not a generic "SSE-KMS"/AWS-managed-key tag, which is free).

interface PaidMarker {
  id: string;
  label: string;
  patterns: RegExp[];
}

const PAID_SECURITY_MARKERS: readonly PaidMarker[] = [
  { id: "waf", label: "AWS WAF web ACL", patterns: [/\bwaf\b/i, /\bweb acl\b/i, /\bwafv2\b/i] },
  { id: "multi-region-trail", label: "multi-region CloudTrail", patterns: [/multi[- ]region trail/i, /multi[- ]region cloudtrail/i] },
  { id: "secrets-manager", label: "AWS Secrets Manager (vs SSM Parameter Store)", patterns: [/secrets manager/i] },
  { id: "customer-cmk", label: "customer-managed KMS CMK", patterns: [/customer[- ]managed (?:cmk|kms|key)/i] },
];

/** Paid-security controls a tier's GRAPH surface evidences (service/role/tags +
 *  cost-driver services). The honest, free counterparts (CloudFront+Shield,
 *  SSE-KMS/AWS-managed key, single-region trail, SSM Parameter Store) match none. */
export function paidSecurityMarkersOnTier(tier: Tier): string[] {
  const surface = [
    ...tier.nodes.flatMap((n) => [n.awsService, n.role, ...n.security]),
    ...tier.costDrivers.map((d) => `${d.service} ${d.unit}`),
  ]
    .join(" \n ");
  const found: string[] = [];
  for (const m of PAID_SECURITY_MARKERS) {
    if (m.patterns.some((p) => p.test(surface))) found.push(m.label);
  }
  return found;
}
