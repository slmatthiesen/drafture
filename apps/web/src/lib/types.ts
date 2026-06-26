/**
 * Frontend mirror of the API's structured-architecture contract.
 *
 * SOURCE OF TRUTH: `apps/api/src/schema/architecture.ts` (Zod). These interfaces
 * are kept in sync MANUALLY for V1 — a shared `@stackdraft/schema` package that
 * both sides import is a later refactor. If you change the API schema, update
 * this file too (and the api client in `./api.ts`).
 */

export const TIER_NAMES = ["budget", "balanced", "resilient"] as const;
export type TierName = (typeof TIER_NAMES)[number];

export interface Node {
  id: string;
  awsService: string;
  purpose: string;
  security: string[];
  scaling: {
    burst: string;
    /** True when burst handling is baked into the core (trivial add); false when it is an option. */
    trivialInCore: boolean;
  };
}

export interface Edge {
  /** Source node id (or a synthetic endpoint like 'client'). */
  from: string;
  to: string;
  /** R4: the data/payload moving across this edge — every edge carries one. */
  payload: string;
  protocol: string;
}

export interface CostDriver {
  service: string;
  /** The service's NATIVE unit — 'per 1k requests' | '$/GB-month' | '$/hr' | '$/GB transferred' (R6). */
  unit: string;
  estimateRange: string;
  /** Clarifying note (e.g. 'required by private-subnet default'); empty string when none. */
  note: string;
}

export interface Tier {
  name: TierName;
  summary: string;
  nodes: Node[];
  edges: Edge[];
  setupSteps: string[];
  costDrivers: CostDriver[];
  burstHandling: string[];
  securityNotes: string[];
  tradeoffs: string[];
}

/**
 * A staff-level architecture decision (ADR-style): the call that was made, what
 * was chosen, the alternatives weighed, and why. Surfaced in the KeyDecisions card.
 */
export interface KeyDecision {
  decision: string;
  chosen: string;
  alternativesConsidered: string[];
  rationale: string;
}

/** 200 response from `/api/generate` when a full design is produced. */
export interface GenerateResponse {
  tiers: Tier[];
  assumptions: string[];
  /** The tier the architect leads with — auto-selected and badged in the UI. */
  recommendedTier: TierName;
  recommendationRationale: string;
  keyDecisions: KeyDecision[];
}

/** 200 response from `/api/config` — an on-demand reference Terraform config. */
export interface ConfigResponse {
  format: string;
  code: string;
}

/** 200 response from `/api/generate` when the model needs more information (R2). */
export interface ClarifyResponse {
  needsClarification: true;
  questions: string[];
  round: number;
}
