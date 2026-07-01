/**
 * @drafture/kb — seeded curated knowledge base (U4).
 *
 * Contracts only here; the JSON seed files are populated in U4 and loaded into
 * the stores on first boot. Each fact is citeable (source URL) so research-on-miss
 * (U6) can append in the exact same shape.
 */

/** The robustness rung a control enters at — the same ladder NAT/ALB/multi-AZ ride. */
export type SecurityTier = "budget" | "balanced" | "resilient";

/**
 * A PAID security step-up that hardens a baseline up the robustness ladder (a
 * customer-managed CMK, a WAF web ACL, a multi-region trail). It enters at its
 * `tierFloor` (balanced or resilient) — NOT in budget — UNLESS the design is
 * compliance-flagged and `escalatesUnderCompliance` is true, which pulls it down
 * into budget (budget = cheapest *correct*, and regulated data makes the paid
 * control correct-required). The free part of the baseline always stays in budget.
 */
export interface SecurityEnhancement {
  id: string;
  /** Lowest tier this PAID control enters at (never "budget" — that's the free floor). */
  tierFloor: "balanced" | "resilient";
  /** Short one-line statement of the paid control (surfaced in the tier delta). */
  summary: string;
  /** Pull this control into budget when intake flags regulated/sensitive data. */
  escalatesUnderCompliance: boolean;
  /** Approx fixed monthly cost the control adds, [low, high] USD. */
  monthlyUsd: [number, number];
}

export interface SecurityBaseline {
  id: string;
  rule: string;
  rationale: string;
  /** Short one-line floor statement, used as the deterministic securityFloor text. */
  summary: string;
  source: string;
  /** Lowest tier the FREE structural baseline applies at — always "budget" (the
   *  $0 floor is universal). Paid hardening rides `enhancements`. */
  tierFloor: SecurityTier;
  /** Paid step-ups that harden this baseline up the robustness ladder (absent for the
   *  baselines that are already free + structural). */
  enhancements?: SecurityEnhancement[];
}

/**
 * Implementation-level Terraform "wire-up" rule: the consequence a resource
 * implies but a model routinely omits (a CMK with no key policy, an ACM cert with
 * no validation resource, …). The security baselines state the POLICY ("encrypt
 * at rest"); these state the runtime consequence ("a CMK encrypting Logs needs a
 * key policy granting the Logs principal"). `terraform plan` stays green on the
 * omission, so without these the gap is invisible until deploy.
 *
 * Rendered into the generateConfig system prompt (`llm/configPrompt.ts`) and
 * checked post-generation (`routes/config.ts` `detectWireupGaps`).
 */
export interface TerraformWireupRule {
  id: string;
  /** The required consequence, phrased as "resource X ⇒ you must also do Y". */
  rule: string;
  /** The runtime failure mode this prevents (plan stays green; fails at runtime). */
  rationale: string;
  source: string;
}

/**
 * A curated, static glossary term surfaced as a hover tooltip in the UI (no LLM).
 * Deterministic product knowledge — version-controlled here, served read-only.
 */
export interface GlossaryTerm {
  /** The term as it appears in output text, e.g. "DLQ", "NAT Gateway". */
  term: string;
  /** A concise, plain-language definition (≤ ~2 sentences). */
  definition: string;
}

export interface ReferenceArchitecture {
  id: string;
  name: string;
  whenToUse: string;
  services: string[];
  burstMechanisms: string[];
  source: string;
}

export interface PricingFact {
  service: string;
  region: string;
  unit: string;
  usd: number;
  note: string;
  source: string;
}

/**
 * The shared instance-size price table (`instance-prices.seed.json`): an
 * `instanceType → us-east-1 on-demand $/hr` map under `prices`, used by BOTH the
 * API cost engine (honor the architect's stated instance size, else a tier
 * default) and the web size-ladder (absolute-price manual override — no ratios).
 * `_note` carries the grounded-estimate disclaimer. Order-of-magnitude, never a
 * live quote.
 */
export interface InstancePriceTable {
  _note: string;
  prices: Record<string, number>;
}

/**
 * One entry in the service catalog (`service-catalog.json`) — the canned config
 * a lean node PICK hydrates against, keyed by `ServiceKey` (see
 * `pipeline/terraform/serviceKey.ts`). This is the reusable knowledge that lets
 * the model emit `{svc, id, role?, addSecurity?}` instead of retyping the same
 * security tags on every node of a given service (see `pipeline/hydrate.ts`).
 */
export interface ServiceCatalogEntry {
  /** Canonical AWS service name the hydrated node's `awsService` gets. */
  awsService: string;
  /** Used when the lean node omits `role`. */
  defaultRole?: string;
  /** FREE-floor security tags — applied at EVERY tier. */
  floorTags: string[];
  /** PAID-floor tags — applied ONLY when `paidSecurityActive(tier, compliance)`. */
  paidTags?: string[];
  /** Informational; the Terraform layer already derives VPC-boundness itself. */
  vpcBound?: boolean;
}

export type ServiceCatalog = Record<string, ServiceCatalogEntry>;
