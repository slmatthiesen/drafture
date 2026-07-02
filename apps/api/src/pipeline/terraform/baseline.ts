/**
 * Always-on baseline the assembler prepends: the Terraform/provider blocks, input
 * variables, account-identity data sources, and the KMS customer-managed keys.
 *
 * The KMS keys are the load-bearing wire-up guarantee. A CMK that encrypts another
 * service's data MUST carry a key policy granting that service principal — the
 * `kms-key-policy` rule in `terraform-wireup-rules.json`. The LLM path forgets this
 * (or writes `logs.${local.region}` which the detector can't see), so we emit the
 * service-principal grant inline, keyed off the LITERAL region, every time the
 * consuming service is present. The gap becomes structurally impossible.
 */
import { type EmitCtx, tierHasEncryptedLogGroup } from "./context.js";
import { type HclBlock, type Jsonish, jsonencode, policyDoc, raw } from "./hcl.js";

export function emitBaseline(ctx: EmitCtx): HclBlock[] {
  const blocks: HclBlock[] = [];
  const usesCloudfront = ctx.has("cloudfront");

  // --- Terraform + provider(s) ---
  blocks.push({
    section: "Providers & variables",
    hcl: [
      `terraform {`,
      `  required_version = ">= 1.6"`,
      `  required_providers {`,
      `    aws = {`,
      `      source  = "hashicorp/aws"`,
      `      version = "~> 5.0"`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `provider "aws" {`,
      `  region = var.aws_region`,
      `}`,
      ...(usesCloudfront
        ? [
            ``,
            `# ACM certs and WAF web ACLs for CloudFront MUST live in us-east-1.`,
            `provider "aws" {`,
            `  alias  = "us_east_1"`,
            `  region = "us-east-1"`,
            `}`,
          ]
        : []),
    ].join("\n"),
  });

  // --- Variables (emitted only for the capabilities present) ---
  const vars: string[] = [
    `variable "aws_region" {`,
    `  type    = string`,
    `  default = "${ctx.region}"`,
    `}`,
  ];
  if (ctx.has("ec2")) {
    vars.push(
      ``,
      `variable "ami_id" {`,
      `  type        = string`,
      `  description = "Machine image for the application box (Amazon Linux 2023 recommended)."`,
      `}`,
    );
  }
  if (usesCloudfront) {
    vars.push(
      ``,
      `variable "domain_name" {`,
      `  type        = string`,
      `  description = "Primary domain served by CloudFront, e.g. example.com."`,
      `}`,
      ``,
      `variable "route53_zone_id" {`,
      `  type        = string`,
      `  description = "Route53 hosted-zone id for domain_name (ACM DNS validation + alias records)."`,
      `}`,
    );
    // A dynamic origin is any non-S3 CloudFront target (EC2/ALB/API Gateway/…). When
    // one exists, the distribution reaches it over var.origin_domain (a custom domain
    // with a real cert), so declare that variable.
    const cfHasDynamicOrigin = ctx
      .nodesOfKey("cloudfront")
      .some((cf) => ctx.out(cf.id).some((e) => {
        const t = ctx.byId(e.to);
        return !!t && ctx.keyOf(t) !== "s3";
      }));
    if (cfHasDynamicOrigin) {
      vars.push(
        ``,
        `# A CloudFront https-only origin must present a trusted-CA cert for its hostname.`,
        `# NEVER an EC2 instance public DNS / raw ALB DNS name (no cert, churns on replace)`,
        `# — supply a custom domain (ALB or EIP + Route53) with an ACM cert. (rule:`,
        `# cloudfront-origin-tls)`,
        `variable "origin_domain" {`,
        `  type        = string`,
        `  description = "Custom domain (ALB / EIP + Route53) for the dynamic origin — MUST have a TLS cert."`,
        `}`,
      );
    }
  }
  if (ctx.has("alb")) {
    vars.push(
      ``,
      `variable "alb_certificate_arn" {`,
      `  type        = string`,
      `  description = "Regional ACM certificate ARN for the ALB HTTPS listener (origin_domain)."`,
      `}`,
    );
  }
  if (ctx.has("sns")) {
    vars.push(
      ``,
      `variable "ops_email" {`,
      `  type        = string`,
      `  description = "Destination for SNS ops alerts."`,
      `}`,
    );
  }
  blocks.push({ section: "Providers & variables", hcl: vars.join("\n") });

  // --- Account identity + locals ---
  blocks.push({
    section: "Providers & variables",
    hcl: [
      `data "aws_caller_identity" "current" {}`,
      `data "aws_partition" "current" {}`,
      ``,
      `locals {`,
      `  account_id = data.aws_caller_identity.current.account_id`,
      `  partition  = data.aws_partition.current.partition`,
      `  region     = var.aws_region`,
      `}`,
    ].join("\n"),
  });

  // --- KMS customer-managed CMKs (S3/EBS/Secrets, CloudWatch Logs, SNS) ---
  // PAID security floor (~$1/key/mo): a balanced+ step-up, OR budget under compliance.
  // The budget tier (none-sensitivity) encrypts at rest with FREE AWS-managed keys
  // (SSE-S3 / aws/ebs / aws/secretsmanager / aws/sns), so no CMK is emitted and the
  // consuming resources reference the managed key — keeping budget on the lean floor.
  if (ctx.paidSecurity) emitCustomerCmks(ctx, blocks);

  return blocks;
}

function emitCustomerCmks(ctx: EmitCtx, blocks: HclBlock[]): void {
  const p = ctx.prefix;
  const rootStmt = {
    Sid: "RootAccountFullAccess",
    Effect: "Allow",
    Principal: { AWS: raw('"arn:${local.partition}:iam::${local.account_id}:root"') },
    Action: "kms:*",
    Resource: "*",
  };
  const mainStatements: Jsonish[] = [rootStmt];
  if (ctx.has("secrets-manager")) {
    mainStatements.push({
      Sid: "AllowSecretsManager",
      Effect: "Allow",
      Principal: { Service: "secretsmanager.amazonaws.com" },
      Action: ["kms:Decrypt", "kms:GenerateDataKey*", "kms:CreateGrant", "kms:DescribeKey"],
      Resource: "*",
    });
  }
  blocks.push({
    section: "KMS keys",
    hcl: [
      `# General-purpose CMK — S3 buckets, EBS volumes, Secrets Manager.`,
      `resource "aws_kms_key" "main" {`,
      `  description             = "${p} main CMK — S3, EBS, Secrets Manager"`,
      `  enable_key_rotation     = true`,
      `  deletion_window_in_days = 30`,
      ``,
      `  policy = ${indentPolicy(jsonencode(policyDoc(mainStatements)))}`,
      `}`,
      ``,
      `resource "aws_kms_alias" "main" {`,
      `  name          = "alias/${p}-main"`,
      `  target_key_id = aws_kms_key.main.key_id`,
      `}`,
    ].join("\n"),
  });

  // --- KMS: CloudWatch Logs CMK (needs the logs service principal, LITERAL region) ---
  // Required whenever ANYTHING writes an encrypted log group: a log sink, CloudTrail, a
  // Lambda, API Gateway, or a Fargate task — the LOG_GROUP_KEYS set the emitters share.
  if (tierHasEncryptedLogGroup(ctx)) {
    blocks.push({
      section: "KMS keys",
      hcl: [
        `# CloudWatch Logs CMK — the Logs service principal MUST be granted, keyed off`,
        `# the LITERAL region (not \${local.region}), or PutLogEvents fails at runtime.`,
        `resource "aws_kms_key" "cw_logs" {`,
        `  description             = "${p} CloudWatch Logs CMK"`,
        `  enable_key_rotation     = true`,
        `  deletion_window_in_days = 30`,
        ``,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              rootStmt,
              {
                Sid: "AllowCloudWatchLogs",
                Effect: "Allow",
                Principal: { Service: `logs.${ctx.region}.amazonaws.com` },
                Action: ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"],
                Resource: "*",
                Condition: {
                  ArnLike: {
                    "kms:EncryptionContext:aws:logs:arn": raw(
                      `"arn:\${local.partition}:logs:${ctx.region}:\${local.account_id}:*"`,
                    ),
                  },
                },
              },
            ]),
          ),
        )}`,
        `}`,
        ``,
        `resource "aws_kms_alias" "cw_logs" {`,
        `  name          = "alias/${p}-cw-logs"`,
        `  target_key_id = aws_kms_key.cw_logs.key_id`,
        `}`,
      ].join("\n"),
    });
  }

  // --- KMS: SNS CMK (CloudWatch alarms → SNS needs cloudwatch + sns principals) ---
  if (ctx.has("sns")) {
    blocks.push({
      section: "KMS keys",
      hcl: [
        `# SNS CMK — a CloudWatch alarm publishing to an encrypted topic needs BOTH the`,
        `# cloudwatch and sns service principals, or alarm publish fails at runtime.`,
        `resource "aws_kms_key" "sns" {`,
        `  description             = "${p} SNS ops-alert CMK"`,
        `  enable_key_rotation     = true`,
        `  deletion_window_in_days = 30`,
        ``,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              rootStmt,
              {
                Sid: "AllowCloudWatchAlarms",
                Effect: "Allow",
                Principal: { Service: "cloudwatch.amazonaws.com" },
                Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
                Resource: "*",
              },
              {
                Sid: "AllowSNSService",
                Effect: "Allow",
                Principal: { Service: "sns.amazonaws.com" },
                Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
                Resource: "*",
              },
            ]),
          ),
        )}`,
        `}`,
        ``,
        `resource "aws_kms_alias" "sns" {`,
        `  name          = "alias/${p}-sns"`,
        `  target_key_id = aws_kms_key.sns.key_id`,
        `}`,
      ].join("\n"),
    });
  }
}

/** Re-indent a multi-line jsonencode(...) so nested lines sit under the `policy =`. */
function indentPolicy(json: string): string {
  return json
    .split("\n")
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join("\n");
}
