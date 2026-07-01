/**
 * Storage emitters — S3 buckets and Secrets Manager secrets. Both encrypt with the
 * general-purpose CMK and deny non-TLS access inline (encrypt-at-rest +
 * encrypt-in-transit, by construction). A bucket that is a CloudFront origin also
 * gets the OAC source-ARN grant; a Secrets secret deliberately emits NO rotation
 * resource (a null rotation_lambda_arn is invalid — `secretsmanager-rotation-lambda`).
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { ref, type EmitCtx } from "../context.js";
import { type HclBlock, type Jsonish, jsonencode, policyDoc, raw } from "../hcl.js";

const tag = (node: ArchitectureNode, kw: string): boolean =>
  node.security.some((s) => s.toLowerCase().includes(kw));

export function emitS3(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `S3 — ${node.role}`;
  const blocks: HclBlock[] = [];

  const cfOrigin = ctx.in(node.id).find((e) => {
    const from = ctx.byId(e.from);
    return from && ctx.keyOf(from) === "cloudfront";
  });

  blocks.push({
    section,
    hcl: [
      `resource "aws_s3_bucket" "${tf}" {`,
      `  bucket_prefix = "${ctx.prefix}-${tf.replace(/_/g, "-")}-"`,
      `  force_destroy = false`,
      `}`,
      ``,
      `resource "aws_s3_bucket_server_side_encryption_configuration" "${tf}" {`,
      `  bucket = aws_s3_bucket.${tf}.id`,
      `  rule {`,
      `    apply_server_side_encryption_by_default {`,
      // Budget floor: SSE-S3 (AES256, AWS-managed, free, still encrypted at rest).
      // Balanced+/compliance: a customer-managed CMK for auditable rotation.
      ...(ctx.paidSecurity
        ? [`      sse_algorithm     = "aws:kms"`, `      kms_master_key_id = aws_kms_key.main.arn`]
        : [`      sse_algorithm     = "AES256"`]),
      `    }`,
      `    bucket_key_enabled = true`,
      `  }`,
      `}`,
      ``,
      `resource "aws_s3_bucket_public_access_block" "${tf}" {`,
      `  bucket                  = aws_s3_bucket.${tf}.id`,
      `  block_public_acls       = true`,
      `  block_public_policy     = true`,
      `  ignore_public_acls      = true`,
      `  restrict_public_buckets = true`,
      `}`,
      ...(tag(node, "version")
        ? [
            ``,
            `resource "aws_s3_bucket_versioning" "${tf}" {`,
            `  bucket = aws_s3_bucket.${tf}.id`,
            `  versioning_configuration { status = "Enabled" }`,
            `}`,
          ]
        : []),
    ].join("\n"),
  });

  const arn = ref.s3Arn(ctx, node.id); // aws_s3_bucket.<tf>.arn
  const bucketAndObjects = [raw(arn), raw(`"\${${arn}}/*"`)];
  const statements: Jsonish[] = [
    {
      Sid: "DenyNonTLS",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: bucketAndObjects,
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ];

  if (cfOrigin) {
    statements.push({
      Sid: "AllowCloudFrontOAC",
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: raw(`"\${${ref.s3Arn(ctx, node.id)}}/*"`),
      Condition: { StringEquals: { "AWS:SourceArn": raw(`aws_cloudfront_distribution.${ctx.tf(cfOrigin.from)}.arn`) } },
    });
  }

  blocks.push({
    section,
    hcl: [
      `resource "aws_s3_bucket_policy" "${tf}" {`,
      `  bucket = aws_s3_bucket.${tf}.id`,
      `  policy = ${jsonencode(policyDoc(statements)).split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n")}`,
      `}`,
    ].join("\n"),
  });

  return blocks;
}

/**
 * SSM Parameter Store — the FREE-floor secrets/config store (the budget tier's default;
 * AWS Secrets Manager is the paid step-up). SecureString parameters under a per-node
 * path, encrypted with the AWS-managed `aws/ssm` key at the budget floor or the customer
 * CMK at balanced+. Values are injected out-of-band via a sensitive map variable — never
 * a committed secret. A `for_each` over an empty default map creates nothing until the
 * operator supplies parameters, which is the right reference-only starting point.
 */
export function emitSsmParameterStore(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const dash = tf.replace(/_/g, "-");
  return [
    {
      section: `SSM Parameter Store — ${node.role}`,
      hcl: [
        `variable "${tf}_parameters" {`,
        `  type        = map(string)`,
        `  description = "SecureString parameters for ${node.role} (name -> value). Inject out-of-band; do not commit secrets."`,
        `  default     = {}`,
        `  sensitive   = true`,
        `}`,
        ``,
        `resource "aws_ssm_parameter" "${tf}" {`,
        `  for_each = var.${tf}_parameters`,
        `  name     = "/${ctx.prefix}/${dash}/\${each.key}"`,
        `  type     = "SecureString"`,
        `  value    = each.value`,
        // Budget floor: the AWS-managed aws/ssm key (free). Balanced+/compliance: a CMK.
        ...(ctx.paidSecurity ? [`  key_id   = aws_kms_key.main.arn`] : []),
        `}`,
      ].join("\n"),
    },
  ];
}

export function emitSecrets(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  return [
    {
      section: `Secrets Manager — ${node.role}`,
      hcl: [
        `# No rotation Lambda is provided, so the rotation resource is intentionally`,
        `# OMITTED — a null rotation_lambda_arn is invalid (rule: secretsmanager-rotation-lambda).`,
        `resource "aws_secretsmanager_secret" "${tf}" {`,
        `  name       = "${ctx.prefix}/${tf.replace(/_/g, "-")}"`,
        // Budget floor: the AWS-managed aws/secretsmanager key (free). Balanced+: a CMK.
        ...(ctx.paidSecurity ? [`  kms_key_id = aws_kms_key.main.arn`] : []),
        `}`,
        ``,
        `resource "aws_secretsmanager_secret_version" "${tf}" {`,
        `  secret_id     = aws_secretsmanager_secret.${tf}.id`,
        `  secret_string = jsonencode({`,
        `    username = "REPLACE_ME"`,
        `    password = "REPLACE_ME" # inject out-of-band; do not commit a real secret`,
        `  })`,
        `}`,
      ].join("\n"),
    },
  ];
}
