import { describe, it, expect } from "vitest";

import type { ArchitectureResult, Tier } from "../schema/architecture.js";
import { reviewBudget } from "./budgetReview.js";

function tier(name: Tier["name"], over: Partial<Tier> = {}): Tier {
  return {
    name,
    summary: "",
    nodes: [{ id: "fn", awsService: "Lambda", role: "api", security: ["TLS"] }],
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

describe("reviewBudget (internalized senior-architect review)", () => {
  it("PASSES a serverless, free-floor budget", () => {
    const r = reviewBudget(result());
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === "blocker")).toBe(false);
    expect(r.summary).toMatch(/PASSED/);
  });

  it("reproduces the 'paid security on budget' finding (the reviewers' #1)", () => {
    const overbuilt = result({
      tiers: [
        tier("budget", {
          nodes: [
            { id: "cf", awsService: "CloudFront + WAF", role: "edge", security: ["WAF managed rules"] },
            { id: "sm", awsService: "AWS Secrets Manager", role: "creds", security: [] },
            { id: "ct", awsService: "CloudTrail", role: "audit", security: ["multi-region trail"] },
          ],
        }),
        tier("balanced"),
        tier("resilient"),
      ],
    });
    const r = reviewBudget(overbuilt);
    expect(r.ok).toBe(false);
    const finding = r.findings.find((f) => f.id === "paid-security-on-budget");
    expect(finding?.severity).toBe("blocker");
    expect(finding?.detail).toMatch(/WAF/);
    expect(finding?.detail).toMatch(/Secrets Manager/);
  });

  it("EXEMPTS the paid floor under compliance (correct-required)", () => {
    const pci = result({
      keyDecisions: [
        { decision: "PCI scope", chosen: "Tokenize cardholder data", alternativesConsidered: [], rationale: "out of scope" },
      ],
      tiers: [
        tier("budget", {
          nodes: [{ id: "cf", awsService: "CloudFront + WAF", role: "edge", security: ["WAF", "PCI scope"] }],
        }),
        tier("balanced"),
        tier("resilient"),
      ],
    });
    const r = reviewBudget(pci);
    expect(r.compliance).toBe(true);
    const finding = r.findings.find((f) => f.id === "paid-security-on-budget");
    expect(finding?.severity).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("reproduces the 'always-on managed quartet' finding from the idle floor", () => {
    const quartet = result({
      tiers: [
        tier("budget", {
          costDrivers: [
            { service: "NAT Gateway", unit: "$/hr", estimateRange: "$32.85–$65.70/mo", note: "" },
            { service: "ALB", unit: "$/hr", estimateRange: "$16.43–$32.85/mo", note: "" },
            { service: "RDS", unit: "$/hr", estimateRange: "$24.82–$49.64/mo", note: "" },
          ],
        }),
        tier("balanced"),
        tier("resilient"),
      ],
    });
    const r = reviewBudget(quartet);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.id === "always-on-quartet" && f.severity === "blocker")).toBe(true);
  });

  it("always states an honest all-in baseline", () => {
    const r = reviewBudget(result());
    expect(r.findings.some((f) => f.id === "all-in-baseline")).toBe(true);
  });
});
