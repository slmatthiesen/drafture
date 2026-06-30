import { describe, it, expect } from "vitest";

import securityBaselines from "@drafture/kb/security-baselines.json" with { type: "json" };
import type { SecurityBaseline } from "@drafture/kb";

import type { ArchitectureResult, Tier } from "../schema/architecture.js";
import {
  FLOOR_ENHANCEMENTS,
  enhancementActive,
  isEnhancementActive,
  paidSecurityActive,
  multiRegionTrailActive,
  isComplianceFlagged,
  tierIsComplianceFlagged,
  securityFloorCostDrivers,
  paidSecurityMarkersOnTier,
} from "./securityTiers.js";

const baselines = securityBaselines as SecurityBaseline[];

// The four free + structural controls (always budget, no paid enhancement) and the
// four that carry a paid step-up up the ladder.
const FREE_ONLY = ["encrypt-in-transit", "least-privilege-iam", "s3-block-public-access", "no-public-data-tier"];
const PAID = ["encrypt-at-rest", "secrets-manager", "edge-protection", "audit-and-access-logging"];

describe("KB tier-classification (Step 1)", () => {
  it("every baseline declares a tierFloor, and the FREE floor is universal (budget)", () => {
    for (const b of baselines) {
      expect(b.tierFloor, b.id).toBe("budget");
    }
  });

  it("the four structural controls carry NO paid enhancement; the four hardenable ones do", () => {
    for (const b of baselines) {
      if (FREE_ONLY.includes(b.id)) {
        expect(b.enhancements ?? [], b.id).toHaveLength(0);
      }
      if (PAID.includes(b.id)) {
        expect((b.enhancements ?? []).length, b.id).toBeGreaterThan(0);
      }
    }
  });

  it("every paid enhancement enters at balanced or resilient (never budget) and has a cost band", () => {
    for (const e of FLOOR_ENHANCEMENTS) {
      expect(["balanced", "resilient"], e.id).toContain(e.tierFloor);
      expect(e.monthlyUsd[0], e.id).toBeGreaterThanOrEqual(0);
      expect(e.monthlyUsd[1]).toBeGreaterThanOrEqual(e.monthlyUsd[0]);
    }
  });
});

describe("enhancement activeness (the one switch)", () => {
  const waf = FLOOR_ENHANCEMENTS.find((e) => e.id === "waf-web-acl")!;
  const trail = FLOOR_ENHANCEMENTS.find((e) => e.id === "multi-region-trail")!;

  it("WAF/CMK/Secrets enter at balanced, NOT budget, when none-sensitivity", () => {
    expect(enhancementActive(waf, "budget", false)).toBe(false);
    expect(enhancementActive(waf, "balanced", false)).toBe(true);
    expect(enhancementActive(waf, "resilient", false)).toBe(true);
    expect(paidSecurityActive("budget", false)).toBe(false);
    expect(paidSecurityActive("balanced", false)).toBe(true);
  });

  it("the multi-region trail is resilient-only when none-sensitivity", () => {
    expect(enhancementActive(trail, "budget", false)).toBe(false);
    expect(enhancementActive(trail, "balanced", false)).toBe(false);
    expect(enhancementActive(trail, "resilient", false)).toBe(true);
    expect(multiRegionTrailActive("balanced", false)).toBe(false);
    expect(multiRegionTrailActive("resilient", false)).toBe(true);
  });

  it("COMPLIANCE OVERRIDE pulls the escalating paid floor down into budget", () => {
    expect(enhancementActive(waf, "budget", true)).toBe(true);
    expect(enhancementActive(trail, "budget", true)).toBe(true);
    expect(paidSecurityActive("budget", true)).toBe(true);
    expect(multiRegionTrailActive("budget", true)).toBe(true);
    expect(isEnhancementActive("customer-managed-cmk", "budget", true)).toBe(true);
  });
});

function tier(name: Tier["name"], over: Partial<Tier> = {}): Tier {
  return {
    name,
    summary: "",
    nodes: [{ id: "n", awsService: "Lambda", role: "api", security: ["TLS"] }],
    edges: [],
    costDrivers: [],
    delta: [],
    tradeoffs: [],
    ...over,
  };
}

function result(over: Partial<ArchitectureResult> = {}): ArchitectureResult {
  return {
    assumptions: [],
    clarificationsUsed: [],
    keyDecisions: [],
    securityFloor: [],
    recommendedTier: "balanced",
    recommendationRationale: "",
    tiers: [tier("budget"), tier("balanced"), tier("resilient")],
    ...over,
  };
}

describe("compliance detection", () => {
  it("fires on a regulated regime named in a keyDecision", () => {
    const r = result({
      keyDecisions: [
        {
          decision: "PCI scope minimization",
          chosen: "Tokenize cardholder data with the processor",
          alternativesConsidered: ["store PANs"],
          rationale: "Keeps the checkout API out of PCI scope.",
        },
      ],
    });
    expect(isComplianceFlagged(r)).toBe(true);
  });

  it("does NOT fire on a none-sensitivity design", () => {
    expect(isComplianceFlagged(result())).toBe(false);
  });

  it("a tier-local detector reads node tags (what the emitter sees)", () => {
    const pci = tier("budget", {
      nodes: [{ id: "db", awsService: "DynamoDB", role: "ledger", security: ["PCI scope", "TLS"] }],
    });
    expect(tierIsComplianceFlagged(pci)).toBe(true);
    expect(tierIsComplianceFlagged(tier("budget"))).toBe(false);
  });
});

describe("securityFloorCostDrivers (cost-table honesty)", () => {
  it("budget (none-sensitivity) carries ZERO fixed paid-security cost", () => {
    expect(securityFloorCostDrivers("budget", false)).toHaveLength(0);
  });

  it("balanced introduces WAF + customer CMK + Secrets-Manager rotation, NOT the multi-region trail", () => {
    const services = securityFloorCostDrivers("balanced", false).map((d) => d.service);
    expect(services).toContain("AWS WAF (web ACL)");
    expect(services).toContain("KMS (customer-managed CMKs)");
    expect(services).toContain("Secrets Manager (rotation)");
    expect(services.join(" ")).not.toMatch(/multi-region/i);
  });

  it("resilient adds the multi-region trail line", () => {
    const services = securityFloorCostDrivers("resilient", false).map((d) => d.service);
    expect(services.some((s) => /multi-region/i.test(s))).toBe(true);
  });

  it("budget UNDER COMPLIANCE carries the full paid floor", () => {
    const services = securityFloorCostDrivers("budget", true).map((d) => d.service);
    expect(services).toContain("AWS WAF (web ACL)");
    expect(services.some((s) => /multi-region/i.test(s))).toBe(true);
  });
});

describe("paidSecurityMarkersOnTier (gate surface)", () => {
  it("flags a WAF web-ACL, a multi-region trail, and a Secrets Manager node", () => {
    const t = tier("budget", {
      nodes: [
        { id: "cf", awsService: "CloudFront + WAF", role: "edge", security: ["WAF managed rules"] },
        { id: "ct", awsService: "CloudTrail", role: "audit", security: ["multi-region trail"] },
        { id: "sm", awsService: "AWS Secrets Manager", role: "creds", security: ["rotation enabled"] },
      ],
    });
    const markers = paidSecurityMarkersOnTier(t);
    expect(markers.some((m) => /WAF/i.test(m))).toBe(true);
    expect(markers.some((m) => /multi-region/i.test(m))).toBe(true);
    expect(markers.some((m) => /Secrets Manager/i.test(m))).toBe(true);
  });

  it("does NOT flag the FREE counterparts (CloudFront+Shield, SSE-KMS, single-region trail, SSM)", () => {
    const t = tier("budget", {
      nodes: [
        { id: "cf", awsService: "CloudFront", role: "edge", security: ["Shield Standard", "SSE-KMS at rest"] },
        { id: "ct", awsService: "CloudTrail", role: "audit", security: ["single-region trail"] },
        { id: "ssm", awsService: "SSM Parameter Store", role: "config", security: ["SecureString"] },
      ],
    });
    expect(paidSecurityMarkersOnTier(t)).toHaveLength(0);
  });
});
