/**
 * Hydration (Layer A — service catalog, docs/plans/2026-07-01-009): turns the
 * model's LEAN node picks (`{svc, id, role?, addSecurity?}`) into full
 * `ArchitectureNode`s by pulling the canonical AWS service name and the
 * safe-by-default security tags from the KB service catalog
 * (`@drafture/kb/service-catalog.json`). $0, sub-µs, on every generation — the
 * model stops re-typing the same ~8 floor tags on every node of a given
 * service; only design-specific controls (`addSecurity`) still ride the wire.
 *
 * A node that is ALREADY full (a node inherited unchanged across an "add
 * tier" merge — see `reconstructAddedTier`) passes through untouched.
 */
import catalog from "@drafture/kb/service-catalog.json" with { type: "json" };
import type { ServiceCatalog } from "@drafture/kb";

import type {
  ArchitectureNode,
  GeneratedArchitecture,
  PreHydrationArchitecture,
  PreHydrationNode,
  LeanNode,
  TierName,
} from "../schema/architecture.js";

import { isComplianceFlagged, paidSecurityActive } from "./securityTiers.js";
import { normalizeServiceKey } from "./terraform/serviceKey.js";

const CATALOG = catalog as ServiceCatalog;

function isLeanNode(node: PreHydrationNode): node is LeanNode {
  return "svc" in node;
}

/** Catalog entry for a lean node's `svc`, via the SAME normalizer the Terraform
 *  emitter uses — one vocabulary for lean emission and TF templating. */
function catalogEntryFor(svc: string) {
  const key = normalizeServiceKey({ awsService: svc, role: "" });
  return CATALOG[key];
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Lean node + tier context → full `ArchitectureNode`. Deterministic, $0. An
 *  unknown `svc` (catalog miss) falls back to the verbatim string as
 *  `awsService` with only `addSecurity` as tags — a novel service still works,
 *  just without the floor-tag saving. An already-full node passes through. */
export function hydrateNode(node: PreHydrationNode, tierName: TierName, compliance: boolean): ArchitectureNode {
  if (!isLeanNode(node)) return node;
  const entry = catalogEntryFor(node.svc);
  const awsService = entry?.awsService ?? node.svc;
  const role = node.role ?? entry?.defaultRole ?? node.svc;
  const floorTags = entry?.floorTags ?? [];
  const paidTags = entry && paidSecurityActive(tierName, compliance) ? (entry.paidTags ?? []) : [];
  const security = dedupe([...floorTags, ...paidTags, ...(node.addSecurity ?? [])]);
  return { id: node.id, awsService, role, security };
}

/** A node's compliance-detection surface (role + security-ish tags), whether
 *  it's still lean or already hydrated — read by `isComplianceFlagged`. */
function complianceSurfaceOf(node: PreHydrationNode): { role: string; security: string[] } {
  return isLeanNode(node)
    ? { role: node.role ?? "", security: node.addSecurity ?? [] }
    : { role: node.role, security: node.security };
}

export interface HydrateResult {
  architecture: GeneratedArchitecture;
  /** Count of lean nodes whose `svc` didn't match any catalog entry — data for
   *  which catalog entry to add next, not guesswork (routes/generate.ts telemetry). */
  catalogMiss: number;
}

/**
 * Hydrate every tier of a pre-hydration architecture. Compliance is computed
 * ONCE up front from the whole design's surface (assumptions + keyDecisions +
 * every node's role/security-ish tags) — all of that is present PRE-hydration
 * (a lean node's `role`/`addSecurity` carry any regime marker just as a full
 * node's `role`/`security` would), so there is no ordering hazard between
 * "is this compliance-flagged" and "hydrate the paid floor accordingly".
 *
 * Reused by all three generation entrypoints in `pipeline/generate.ts`: the
 * 3-tier / lazy-budget scopes (every tier all-lean) and the "add tier" scope
 * (one MIXED tier — new/changed nodes lean, unchanged ones already full —
 * merged alongside the client-sent budget tier so compliance sees the whole
 * design, not just the new tier).
 */
export function hydrateArchitecture(pre: PreHydrationArchitecture): HydrateResult {
  const compliance = isComplianceFlagged({
    assumptions: pre.assumptions,
    keyDecisions: pre.keyDecisions,
    tiers: pre.tiers.map((t) => ({ nodes: t.nodes.map(complianceSurfaceOf) })),
  } as never);

  const catalogMiss = pre.tiers
    .flatMap((t) => t.nodes)
    .filter((n) => isLeanNode(n) && !catalogEntryFor(n.svc)).length;

  const tiers = pre.tiers.map((t) => ({
    ...t,
    nodes: t.nodes.map((n) => hydrateNode(n, t.name, compliance)),
  }));

  return {
    architecture: {
      assumptions: pre.assumptions,
      clarificationsUsed: pre.clarificationsUsed,
      keyDecisions: pre.keyDecisions,
      tiers,
    },
    catalogMiss,
  };
}
