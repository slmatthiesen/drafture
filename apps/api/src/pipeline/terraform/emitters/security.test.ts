import { describe, it, expect } from "vitest";

import { detectWireupGaps } from "../../../routes/config.js";
import type { ArchitectureEdge, ArchitectureNode, Tier } from "../../../schema/architecture.js";

import { assembleTier } from "../assemble.js";
import { normalizeServiceKey } from "../serviceKey.js";

const n = (id: string, awsService: string, role: string, security: string[] = []): ArchitectureNode => ({
  id,
  awsService,
  role,
  security,
});
const e = (from: string, to: string, payload = "data", protocol = "HTTPS"): ArchitectureEdge => ({
  from,
  to,
  payload,
  protocol,
});

/**
 * A serverless QR-code API — the shape that used to fall to the LLM fallback because
 * its explicit security-floor nodes (KMS, WAF) had no emitter. It exercises the full
 * serverless spine (CloudFront + API Gateway + Lambda + DynamoDB + S3) plus the
 * balanced+ security floor (KMS, WAF, Secrets Manager, CloudTrail, SNS, Cognito).
 */
function qrApiTier(name: "budget" | "balanced" | "resilient"): Tier {
  return {
    name,
    summary: "serverless QR-code API with the security floor",
    nodes: [
      n("cdn", "CloudFront", "CDN edge"),
      n("waf", "AWS WAF", "web ACL (managed rules + rate limit)"),
      n("gw", "API Gateway", "HTTP API front door", ["throttling"]),
      n("fn", "AWS Lambda", "QR generator", ["least-priv role"]),
      n("tbl", "DynamoDB", "QR metadata"),
      n("assets", "Amazon S3", "generated QR images"),
      n("kms", "AWS KMS", "customer-managed CMK"),
      n("sec", "AWS Secrets Manager", "third-party API keys"),
      n("trail", "AWS CloudTrail", "audit trail"),
      n("topic", "Amazon SNS", "ops alerts", ["TLS"]),
      n("pool", "Amazon Cognito", "user pool", ["MFA optional"]),
    ],
    edges: [
      e("client", "cdn"),
      e("cdn", "gw"),
      e("gw", "fn", "request", "HTTPS"),
      e("fn", "tbl", "PutItem", "HTTPS"),
      e("fn", "assets", "PutObject", "HTTPS"),
      e("fn", "sec", "GetSecretValue", "HTTPS"),
      e("fn", "pool", "AdminInitiateAuth", "HTTPS"),
      e("fn", "topic", "Publish", "HTTPS"),
      e("cdn", "assets", "origin", "HTTPS"),
    ],
    delta: [],
    costDrivers: [],
    tradeoffs: [],
  } as Tier;
}

describe("deterministic Terraform — security-floor nodes (KMS + WAF)", () => {
  it("normalizes KMS and WAF to their own keys (not 'unsupported'), without stealing others", () => {
    expect(normalizeServiceKey({ awsService: "AWS KMS", role: "cmk" })).toBe("kms");
    expect(normalizeServiceKey({ awsService: "AWS Key Management Service", role: "cmk" })).toBe("kms");
    expect(normalizeServiceKey({ awsService: "AWS WAF", role: "web acl" })).toBe("waf");
    expect(normalizeServiceKey({ awsService: "WAFv2 web ACL", role: "L7 firewall" })).toBe("waf");
    // Regressions: an "kms" substring in a storage service must NOT steal it; concrete
    // services claim their node first (KMS is matched last).
    expect(normalizeServiceKey({ awsService: "Amazon S3 (SSE-KMS)", role: "assets" })).toBe("s3");
    expect(normalizeServiceKey({ awsService: "DynamoDB (KMS-encrypted)", role: "table" })).toBe("dynamo");
    expect(normalizeServiceKey({ awsService: "Amazon Kinesis (KMS at rest)", role: "stream" })).toBe("kinesis");
  });

  for (const tier of ["budget", "balanced", "resilient"] as const) {
    describe(`${tier} tier`, () => {
      const { code, coverage, gaps } = assembleTier(qrApiTier(tier), { region: "us-east-1" });

      it("templates the whole tier with zero wire-up gaps (no LLM fallback)", () => {
        expect(coverage.unsupported).toEqual([]);
        expect(coverage.ratio).toBe(1);
        expect(gaps).toEqual([]);
        expect(detectWireupGaps(code)).toEqual([]);
      });

      it("covers the KMS node with a note (the CMKs are emitted in the baseline)", () => {
        expect(code).toContain("# KMS 'kms' (customer-managed CMK)");
        // No duplicate/standalone aws_kms_key from the node emitter — the baseline owns them.
        expect(code).not.toContain('resource "aws_kms_key" "kms"');
      });

      it("covers the WAF node with a note pointing at the CloudFront web ACL", () => {
        expect(code).toContain("# WAF 'waf' (web ACL (managed rules + rate limit))");
        // The WAF node emitter does NOT emit its own web ACL when CloudFront fronts the tier.
        expect(code).not.toContain('resource "aws_wafv2_web_acl" "waf"');
      });

      it("keeps braces/brackets balanced and has no undefined/NaN leaks", () => {
        const count = (s: string, c: string): number => s.split(c).length - 1;
        expect(count(code, "{")).toBe(count(code, "}"));
        expect(count(code, "[")).toBe(count(code, "]"));
        expect(code).not.toContain("undefined");
        expect(code).not.toContain("NaN");
      });
    });
  }

  it("balanced+ still emits the actual CLOUDFRONT web ACL + the baseline CMKs the notes reference", () => {
    const { code } = assembleTier(qrApiTier("balanced"), { region: "us-east-1" });
    expect(code).toContain('resource "aws_wafv2_web_acl" "cdn"');
    expect(code).toContain('scope       = "CLOUDFRONT"');
    expect(code).toContain('resource "aws_kms_key" "main"');
  });
});

/**
 * A WAF node with NO CloudFront but a regional target (an ALB) emits a REAL regional
 * web ACL + association — the correct placement when there's no edge distribution.
 */
function albWafTier(): Tier {
  return {
    name: "budget",
    summary: "ALB-fronted service protected by a regional WAF",
    nodes: [
      n("waf", "AWS WAF", "regional web ACL"),
      n("lb", "Application Load Balancer", "public entry"),
      n("svc", "AWS Fargate", "web service (2 tasks)"),
    ],
    edges: [e("client", "lb"), e("lb", "svc", "request", "HTTPS")],
    delta: [],
    costDrivers: [],
    tradeoffs: [],
  } as Tier;
}

describe("deterministic Terraform — WAF on a regional target (ALB, no CloudFront)", () => {
  const { code, coverage, gaps } = assembleTier(albWafTier(), { region: "us-east-1" });

  it("templates the tier with zero gaps", () => {
    expect(coverage.unsupported).toEqual([]);
    expect(coverage.ratio).toBe(1);
    expect(gaps).toEqual([]);
    expect(detectWireupGaps(code)).toEqual([]);
  });

  it("emits a REGIONAL web ACL with the managed rule set and rate limit", () => {
    expect(code).toContain('resource "aws_wafv2_web_acl" "waf"');
    expect(code).toContain('scope = "REGIONAL"');
    expect(code).toContain("AWSManagedRulesCommonRuleSet");
    expect(code).toContain("AWSManagedRulesKnownBadInputsRuleSet");
    expect(code).toContain("rate_based_statement");
  });

  it("associates the web ACL with the ALB", () => {
    expect(code).toContain('resource "aws_wafv2_web_acl_association" "waf_lb"');
    expect(code).toContain("resource_arn = aws_lb.lb.arn");
    expect(code).toContain("web_acl_arn  = aws_wafv2_web_acl.waf.arn");
  });
});
