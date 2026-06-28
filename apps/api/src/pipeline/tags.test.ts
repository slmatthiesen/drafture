import { describe, it, expect } from "vitest";

import { tagDesign, FACETS } from "./tags.js";

/** Minimal design shaped like the stored ArchitectureResult — tagDesign only reads
 *  tiers[].nodes/delta/tradeoffs + recommendedTier, so this subset is enough. */
const design = (
  services: string[],
  opts: { recommendedTier?: string; delta?: string[]; securityTags?: string[] } = {},
) => ({
  recommendedTier: opts.recommendedTier ?? "balanced",
  tiers: [
    {
      name: "balanced",
      nodes: services.map((s, i) => ({ id: `n${i}`, awsService: s, security: opts.securityTags ?? [] })),
      delta: opts.delta ?? [],
      tradeoffs: [],
    },
  ],
});

describe("tagDesign", () => {
  it("tags compute + api + data for a typical serverless API", () => {
    const tags = tagDesign(design(["Lambda", "API Gateway", "DynamoDB"]));
    expect(tags).toEqual(expect.arrayContaining(["compute", "api", "data"]));
  });

  it("tags messaging for SQS/SNS/EventBridge", () => {
    expect(tagDesign(design(["Lambda", "SQS", "SNS", "EventBridge"]))).toContain("messaging");
  });

  it("tags realtime for Kinesis", () => {
    expect(tagDesign(design(["Kinesis"]))).toContain("realtime");
  });

  it("tags security when dedicated security services are present", () => {
    expect(tagDesign(design(["KMS", "WAF", "Lambda"]))).toContain("security");
  });

  it("tags security when nodes carry security control tags", () => {
    expect(tagDesign(design(["Lambda"], { securityTags: ["TLS", "DLQ"] }))).toContain("security");
  });

  it("tags robustness for a resilient recommendation", () => {
    expect(tagDesign(design(["Lambda"], { recommendedTier: "resilient" }))).toContain("robustness");
  });

  it("tags robustness for explicit multi-AZ language in delta", () => {
    expect(tagDesign(design(["RDS"], { delta: ["adds multi-AZ with automatic failover"] }))).toContain("robustness");
  });

  it("normalizes vendor prefixes (Amazon/AWS)", () => {
    const tags = tagDesign(design(["Amazon API Gateway", "AWS Lambda"]));
    expect(tags).toEqual(expect.arrayContaining(["api", "compute"]));
  });

  it("returns a sorted, de-duplicated list", () => {
    const tags = tagDesign(design(["Lambda", "Lambda", "DynamoDB", "API Gateway"]));
    expect(tags).toEqual([...new Set(tags)].sort());
  });

  it("is defensive on a malformed/empty body", () => {
    expect(tagDesign({})).toEqual([]);
    expect(tagDesign({ tiers: [] })).toEqual([]);
  });

  it("FACETS is a non-empty vocabulary", () => {
    expect(FACETS.length).toBeGreaterThan(0);
  });
});
