/**
 * CloudFront — the edge. This single emitter carries three of the seven wire-up
 * rules inline so they CANNOT be forgotten:
 *   • acm-certificate-validation — the ACM cert is always paired with its
 *     aws_acm_certificate_validation + Route53 records; the viewer cert references
 *     the *validation* arn, not the raw cert.
 *   • cloudfront-origin-tls — an EC2 origin is reached via var.ec2_origin_domain
 *     (a custom domain with a real cert), NEVER an aws_instance public_dns.
 *   • s3-access-log-delivery — the access-log bucket grants the CloudFront
 *     log-delivery CanonicalUser, so logging doesn't silently no-op under BPA.
 * S3 origins get an OAC; a WAF web ACL (managed rules + rate limit) fronts it.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { type EmitCtx } from "../context.js";
import type { HclBlock } from "../hcl.js";

export function emitCloudfront(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = "CloudFront";
  const blocks: HclBlock[] = [];

  const s3Origins = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "s3");
  // A dynamic origin is any non-S3 CloudFront target — an EC2 box, an ALB, or an
  // API/compute service that has no S3-style OAC. It's reached over a CUSTOM domain
  // with a real TLS cert (var.origin_domain), never a raw AWS DNS name. This also
  // covers targets with no emitter yet (e.g. API Gateway): the distribution still
  // needs a valid origin even while that service is a `# TODO` long-tail fallback.
  const dynamicOrigins = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) !== "s3");

  // --- WAF (managed common + known-bad rule sets + IP rate limit) ---
  blocks.push({
    section,
    hcl: [
      `resource "aws_wafv2_web_acl" "${tf}" {`,
      `  provider    = aws.us_east_1`,
      `  name        = "${ctx.prefix}-cf-waf"`,
      `  scope       = "CLOUDFRONT"`,
      `  default_action {`,
      `    allow {}`,
      `  }`,
      ``,
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
      ``,
      `  visibility_config {`,
      `    cloudwatch_metrics_enabled = true`,
      `    metric_name                = "${ctx.prefix}-cf-waf"`,
      `    sampled_requests_enabled   = true`,
      `  }`,
      `}`,
    ].join("\n"),
  });

  // --- ACM certificate (us-east-1) + DNS validation (rule: acm-certificate-validation) ---
  blocks.push({
    section,
    hcl: [
      `resource "aws_acm_certificate" "${tf}" {`,
      `  provider          = aws.us_east_1`,
      `  domain_name       = var.domain_name`,
      `  validation_method = "DNS"`,
      `  lifecycle { create_before_destroy = true }`,
      `}`,
      ``,
      `resource "aws_route53_record" "${tf}_cert_validation" {`,
      `  for_each = {`,
      `    for dvo in aws_acm_certificate.${tf}.domain_validation_options :`,
      `    dvo.domain_name => {`,
      `      name   = dvo.resource_record_name`,
      `      record = dvo.resource_record_value`,
      `      type   = dvo.resource_record_type`,
      `    }`,
      `  }`,
      `  allow_overwrite = true`,
      `  zone_id         = var.route53_zone_id`,
      `  name            = each.value.name`,
      `  type            = each.value.type`,
      `  ttl             = 60`,
      `  records         = [each.value.record]`,
      `}`,
      ``,
      `resource "aws_acm_certificate_validation" "${tf}" {`,
      `  provider                = aws.us_east_1`,
      `  certificate_arn         = aws_acm_certificate.${tf}.arn`,
      `  validation_record_fqdns = [for r in aws_route53_record.${tf}_cert_validation : r.fqdn]`,
      `}`,
    ].join("\n"),
  });

  // --- Access-log bucket with the CloudFront CanonicalUser grant (rule: s3-access-log-delivery) ---
  blocks.push({
    section,
    hcl: [
      `data "aws_canonical_user_id" "current" {}`,
      `data "aws_cloudfront_log_delivery_canonical_user_id" "current" {}`,
      ``,
      `resource "aws_s3_bucket" "${tf}_logs" {`,
      `  bucket_prefix = "${ctx.prefix}-cf-logs-"`,
      `  force_destroy = false`,
      `}`,
      ``,
      `resource "aws_s3_bucket_ownership_controls" "${tf}_logs" {`,
      `  bucket = aws_s3_bucket.${tf}_logs.id`,
      `  rule { object_ownership = "BucketOwnerPreferred" }`,
      `}`,
      ``,
      `resource "aws_s3_bucket_public_access_block" "${tf}_logs" {`,
      `  bucket                  = aws_s3_bucket.${tf}_logs.id`,
      `  block_public_acls       = true`,
      `  block_public_policy     = true`,
      `  ignore_public_acls      = true`,
      `  restrict_public_buckets = true`,
      `}`,
      ``,
      `# CloudFront delivers access logs as the awslogsdelivery CanonicalUser; grant it`,
      `# FULL_CONTROL or logging silently no-ops under Block Public Access.`,
      `resource "aws_s3_bucket_acl" "${tf}_logs" {`,
      `  depends_on = [aws_s3_bucket_ownership_controls.${tf}_logs]`,
      `  bucket     = aws_s3_bucket.${tf}_logs.id`,
      `  access_control_policy {`,
      `    owner { id = data.aws_canonical_user_id.current.id }`,
      `    grant {`,
      `      grantee {`,
      `        id   = data.aws_cloudfront_log_delivery_canonical_user_id.current.id`,
      `        type = "CanonicalUser"`,
      `      }`,
      `      permission = "FULL_CONTROL"`,
      `    }`,
      `    grant {`,
      `      grantee {`,
      `        id   = data.aws_canonical_user_id.current.id`,
      `        type = "CanonicalUser"`,
      `      }`,
      `      permission = "FULL_CONTROL"`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n"),
  });

  // --- OAC per S3 origin ---
  for (const s3 of s3Origins) {
    const stf = ctx.tf(s3.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_cloudfront_origin_access_control" "${stf}" {`,
        `  name                              = "${ctx.prefix}-${stf.replace(/_/g, "-")}-oac"`,
        `  origin_access_control_origin_type = "s3"`,
        `  signing_behavior                  = "always"`,
        `  signing_protocol                  = "sigv4"`,
        `}`,
      ].join("\n"),
    });
  }

  // --- Distribution ---
  const primaryOriginId = dynamicOrigins[0]
    ? `origin-${ctx.tf(dynamicOrigins[0].id)}`
    : s3Origins[0]
      ? `s3-${ctx.tf(s3Origins[0].id)}`
      : "s3-origin";
  const originBlocks: string[] = [];
  for (const s3 of s3Origins) {
    const stf = ctx.tf(s3.id);
    originBlocks.push(
      `  origin {`,
      `    domain_name              = aws_s3_bucket.${stf}.bucket_regional_domain_name`,
      `    origin_id                = "s3-${stf}"`,
      `    origin_access_control_id = aws_cloudfront_origin_access_control.${stf}.id`,
      `  }`,
    );
  }
  for (const dyn of dynamicOrigins) {
    const dtf = ctx.tf(dyn.id);
    const kind = ctx.keyOf(dyn) === "alb" ? "ALB" : ctx.keyOf(dyn) === "ec2" ? "EC2" : dyn.awsService;
    originBlocks.push(
      `  # ${kind} origin over a custom domain with a TLS cert (NOT a raw AWS DNS name — rule cloudfront-origin-tls).`,
      `  origin {`,
      `    domain_name = var.origin_domain`,
      `    origin_id   = "origin-${dtf}"`,
      `    custom_origin_config {`,
      `      http_port              = 80`,
      `      https_port             = 443`,
      `      origin_protocol_policy = "https-only"`,
      `      origin_ssl_protocols   = ["TLSv1.2"]`,
      `    }`,
      `  }`,
    );
  }
  // An ordered behavior to the first S3 origin when a dynamic origin is the default.
  const staticBehavior =
    dynamicOrigins[0] && s3Origins[0]
      ? [
          `  ordered_cache_behavior {`,
          `    path_pattern           = "/static/*"`,
          `    target_origin_id       = "s3-${ctx.tf(s3Origins[0].id)}"`,
          `    viewer_protocol_policy = "redirect-to-https"`,
          `    allowed_methods        = ["GET", "HEAD"]`,
          `    cached_methods         = ["GET", "HEAD"]`,
          `    compress               = true`,
          `    forwarded_values {`,
          `      query_string = false`,
          `      cookies { forward = "none" }`,
          `    }`,
          `    min_ttl     = 86400`,
          `    default_ttl = 604800`,
          `    max_ttl     = 31536000`,
          `  }`,
        ]
      : [];

  blocks.push({
    section,
    hcl: [
      `resource "aws_cloudfront_distribution" "${tf}" {`,
      `  enabled             = true`,
      `  is_ipv6_enabled     = true`,
      `  http_version        = "http2and3"`,
      `  default_root_object = "index.html"`,
      `  price_class         = "PriceClass_100"`,
      `  web_acl_id          = aws_wafv2_web_acl.${tf}.arn`,
      `  aliases             = [var.domain_name]`,
      ``,
      ...originBlocks,
      ``,
      `  default_cache_behavior {`,
      `    target_origin_id       = "${primaryOriginId}"`,
      `    viewer_protocol_policy = "redirect-to-https"`,
      `    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]`,
      `    cached_methods         = ["GET", "HEAD"]`,
      `    compress               = true`,
      `    forwarded_values {`,
      `      query_string = true`,
      `      cookies { forward = "all" }`,
      `    }`,
      `    min_ttl     = 0`,
      `    default_ttl = 0`,
      `    max_ttl     = 0`,
      `  }`,
      ...staticBehavior,
      ``,
      `  viewer_certificate {`,
      `    acm_certificate_arn      = aws_acm_certificate_validation.${tf}.certificate_arn`,
      `    ssl_support_method       = "sni-only"`,
      `    minimum_protocol_version = "TLSv1.2_2021"`,
      `  }`,
      ``,
      `  logging_config {`,
      `    bucket          = aws_s3_bucket.${tf}_logs.bucket_domain_name`,
      `    prefix          = "cf-logs/"`,
      `    include_cookies = false`,
      `  }`,
      ``,
      `  restrictions {`,
      `    geo_restriction { restriction_type = "none" }`,
      `  }`,
      `}`,
      ``,
      `resource "aws_route53_record" "${tf}_alias" {`,
      `  zone_id = var.route53_zone_id`,
      `  name    = var.domain_name`,
      `  type    = "A"`,
      `  alias {`,
      `    name                   = aws_cloudfront_distribution.${tf}.domain_name`,
      `    zone_id                = aws_cloudfront_distribution.${tf}.hosted_zone_id`,
      `    evaluate_target_health = false`,
      `  }`,
      `}`,
    ].join("\n"),
  });

  return blocks;
}
