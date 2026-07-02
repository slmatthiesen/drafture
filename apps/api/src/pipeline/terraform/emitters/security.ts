/**
 * Security-floor emitters — KMS and AWS WAF, the two services a design routinely
 * lists as explicit graph nodes but whose Terraform is OWNED by another section:
 *   • KMS customer-managed CMKs are emitted in the baseline KMS-keys section (at
 *     balanced+/compliance; the budget floor rides free AWS-managed keys), each
 *     carrying the exact service-principal key policy its consumers need. A KMS node
 *     therefore maps to a NOTE — the keys already exist, deterministically.
 *   • A WAF web ACL fronting a CloudFront distribution is emitted INLINE by the
 *     CloudFront emitter (scope CLOUDFRONT, us-east-1, at balanced+). A WAF node in a
 *     CloudFront tier maps to a note pointing there. When there's no CloudFront but a
 *     regional target (an ALB), the node emits a real REGIONAL web ACL + association —
 *     the correct placement, since an HTTP API Gateway can't take a WAF association and
 *     must be fronted by CloudFront instead.
 *
 * Mapping these to emitters (a note, or the regional web ACL) keeps a security-floor
 * node from routing the WHOLE tier to the paid LLM fallback — coverage stays 100%.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { type EmitCtx } from "../context.js";
import type { HclBlock } from "../hcl.js";

const dash = (tf: string): string => tf.replace(/_/g, "-");

/** KMS keys are emitted in the baseline (KMS keys section) with their per-service key
 *  policies. The node maps to a note so coverage counts it instead of routing the tier
 *  to the LLM fallback. */
export function emitKms(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const detail = ctx.paidSecurity
    ? `# emitted in the KMS KEYS section (aws_kms_key.main / .cw_logs / .sns), each with\n# the exact service-principal key policy its consumers need.`
    : `# not emitted at the budget floor — data is encrypted at rest with FREE AWS-managed\n# keys (SSE-S3, aws/ebs, aws/secretsmanager, aws/sns); a customer CMK is the balanced+ step-up.`;
  return [
    {
      section: "KMS keys",
      dedupeKey: `kms-note-${ctx.tf(node.id)}`,
      hcl: [
        `# KMS '${node.id}' (${node.role}) — customer-managed CMKs are:`,
        detail,
      ].join("\n"),
    },
  ];
}

/** The WAF rule set shared by every web ACL we emit: the two AWS managed rule groups
 *  (common + known-bad inputs) plus an IP rate-limit rule. */
function wafRuleLines(): string[] {
  return [
    ...["AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet"].flatMap((rule, i) => [
      `  rule {`,
      `    name     = "${rule}"`,
      `    priority = ${i + 1}`,
      `    override_action {`,
      `      none {}`,
      `    }`,
      `    statement {`,
      `      managed_rule_group_statement {`,
      `        name        = "${rule}"`,
      `        vendor_name = "AWS"`,
      `      }`,
      `    }`,
      `    visibility_config {`,
      `      cloudwatch_metrics_enabled = true`,
      `      metric_name                = "${rule}"`,
      `      sampled_requests_enabled   = true`,
      `    }`,
      `  }`,
      ``,
    ]),
    `  rule {`,
    `    name     = "RateLimit"`,
    `    priority = 3`,
    `    action {`,
    `      block {}`,
    `    }`,
    `    statement {`,
    `      rate_based_statement {`,
    `        limit              = 2000`,
    `        aggregate_key_type = "IP"`,
    `      }`,
    `    }`,
    `    visibility_config {`,
    `      cloudwatch_metrics_enabled = true`,
    `      metric_name                = "RateLimit"`,
    `      sampled_requests_enabled   = true`,
    `    }`,
    `  }`,
  ];
}

export function emitWaf(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);

  // A CloudFront edge owns the CLOUDFRONT-scoped web ACL (emitted inline in the
  // CloudFront section at balanced+; the budget floor rides Shield Standard). The node
  // maps to a note so it stays covered without duplicating that resource.
  if (ctx.has("cloudfront")) {
    return [
      {
        section: "CloudFront",
        dedupeKey: `waf-note-${tf}`,
        hcl: [
          `# WAF '${node.id}' (${node.role}) — the web ACL fronting this design is emitted`,
          `# in the CLOUDFRONT section (aws_wafv2_web_acl, scope CLOUDFRONT, us-east-1) and`,
          `# attached to the distribution at balanced+ / compliance; the budget floor rides`,
          `# CloudFront + Shield Standard (free L3/L4) with no web ACL. Not a standalone node.`,
        ].join("\n"),
      },
    ];
  }

  // No CloudFront: front the tier's regional target(s). WAF associates with an ALB
  // (regional scope). An HTTP API Gateway (apigatewayv2) does NOT support a WAF
  // association — it must be fronted by CloudFront + a CLOUDFRONT web ACL instead.
  const albs = ctx.nodesOfKey("alb");
  if (albs.length > 0) {
    const blocks: HclBlock[] = [
      {
        section: `WAF — ${node.role}`,
        hcl: [
          `resource "aws_wafv2_web_acl" "${tf}" {`,
          `  name  = "${ctx.prefix}-${dash(tf)}"`,
          `  scope = "REGIONAL"`,
          `  default_action {`,
          `    allow {}`,
          `  }`,
          ``,
          ...wafRuleLines(),
          ``,
          `  visibility_config {`,
          `    cloudwatch_metrics_enabled = true`,
          `    metric_name                = "${ctx.prefix}-${dash(tf)}"`,
          `    sampled_requests_enabled   = true`,
          `  }`,
          `}`,
        ].join("\n"),
      },
    ];
    for (const alb of albs) {
      const atf = ctx.tf(alb.id);
      blocks.push({
        section: `WAF — ${node.role}`,
        hcl: [
          `resource "aws_wafv2_web_acl_association" "${tf}_${atf}" {`,
          `  resource_arn = aws_lb.${atf}.arn`,
          `  web_acl_arn  = aws_wafv2_web_acl.${tf}.arn`,
          `}`,
        ].join("\n"),
      });
    }
    return blocks;
  }

  // No CloudFront and no WAF-associable regional target (e.g. an HTTP-API-only tier).
  return [
    {
      section: `WAF — ${node.role}`,
      dedupeKey: `waf-note-${tf}`,
      hcl: [
        `# WAF '${node.id}' (${node.role}) has no WAF-associable target in this tier: an`,
        `# HTTP API Gateway (apigatewayv2) can't take a web-ACL association, and there's no`,
        `# CloudFront distribution or ALB to attach to. Front the API with CloudFront and`,
        `# attach a CLOUDFRONT-scoped web ACL there, or add a REGIONAL ACL to a REST API.`,
      ].join("\n"),
    },
  ];
}
