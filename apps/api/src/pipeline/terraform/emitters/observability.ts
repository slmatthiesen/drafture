/**
 * Observability emitters — the central app log group, golden-signal alarms, the SNS
 * ops topic, X-Ray (no resource — IAM only), and CloudTrail. The SNS topic policy
 * grants the CloudWatch principal publish (so alarm actions land) and denies
 * non-TLS; the CloudTrail bucket grants the trail's GetBucketAcl + PutObject inline
 * (the two grants CloudTrail silently needs). Alarms reference whatever compute the
 * tier actually runs, derived from the node list — never invented.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { cwLogsKmsLine, ref, type EmitCtx } from "../context.js";
import { type HclBlock, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");

/** The SNS ops topic id (alarms point their actions at it). */
function snsTopicId(ctx: EmitCtx): string | undefined {
  return ctx.nodesOfKey("sns")[0]?.id;
}

export function emitCloudwatchLogs(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  return [
    {
      section: "CloudWatch Logs",
      hcl: [
        `resource "aws_cloudwatch_log_group" "${tf}" {`,
        `  name              = "/${ctx.prefix}/app"`,
        `  retention_in_days = 30`,
        ...cwLogsKmsLine(ctx),
        `}`,
      ].join("\n"),
    },
  ];
}

export function emitCloudwatchAlarms(_node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const snsId = snsTopicId(ctx);
  if (!snsId) return []; // alarms with no notification target add nothing actionable
  const actions = `[${ref.snsArn(ctx, snsId)}]`;
  const alarms: string[] = [];

  for (const ec2 of ctx.nodesOfKey("ec2")) {
    const tf = ctx.tf(ec2.id);
    alarms.push(
      [
        `resource "aws_cloudwatch_metric_alarm" "${tf}_cpu_high" {`,
        `  alarm_name          = "${ctx.prefix}-${tf.replace(/_/g, "-")}-cpu-high"`,
        `  comparison_operator = "GreaterThanThreshold"`,
        `  evaluation_periods  = 3`,
        `  metric_name         = "CPUUtilization"`,
        `  namespace           = "AWS/EC2"`,
        `  period              = 60`,
        `  statistic           = "Average"`,
        `  threshold           = 80`,
        `  alarm_actions       = ${actions}`,
        `  ok_actions          = ${actions}`,
        `  dimensions          = { InstanceId = ${ref.instance(ctx, ec2.id)}.id }`,
        `}`,
      ].join("\n"),
    );
  }
  for (const fn of ctx.nodesOfKey("lambda")) {
    const tf = ctx.tf(fn.id);
    alarms.push(
      [
        `resource "aws_cloudwatch_metric_alarm" "${tf}_errors" {`,
        `  alarm_name          = "${ctx.prefix}-${tf.replace(/_/g, "-")}-errors"`,
        `  comparison_operator = "GreaterThanThreshold"`,
        `  evaluation_periods  = 1`,
        `  metric_name         = "Errors"`,
        `  namespace           = "AWS/Lambda"`,
        `  period              = 300`,
        `  statistic           = "Sum"`,
        `  threshold           = 5`,
        `  alarm_actions       = ${actions}`,
        `  dimensions          = { FunctionName = ${ref.lambda(ctx, fn.id)}.function_name }`,
        `}`,
      ].join("\n"),
    );
  }
  return alarms.map((hcl) => ({ section: "CloudWatch Alarms", hcl }));
}

export function emitSns(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const arn = ref.snsArn(ctx, node.id);
  // An ops topic delivers to email (var.ops_email); a PagerDuty/Slack/webhook
  // escalation topic delivers to an HTTPS endpoint (its own variable, since several
  // SNS topics can coexist and each needs a distinct destination).
  const isWebhook = /pagerduty|slack|webhook|incident|opsgenie/i.test(node.role);
  const subscription = isWebhook
    ? [
        `variable "${tf}_endpoint" {`,
        `  type        = string`,
        `  description = "HTTPS endpoint for ${node.role} (e.g. a PagerDuty/Slack integration URL)."`,
        `}`,
        ``,
        `resource "aws_sns_topic_subscription" "${tf}_sub" {`,
        `  topic_arn = ${arn}`,
        `  protocol  = "https"`,
        `  endpoint  = var.${tf}_endpoint`,
        `}`,
      ]
    : [
        `resource "aws_sns_topic_subscription" "${tf}_email" {`,
        `  topic_arn = ${arn}`,
        `  protocol  = "email"`,
        `  endpoint  = var.ops_email`,
        `}`,
      ];
  return [
    {
      section: `SNS — ${node.role}`,
      hcl: [
        `resource "aws_sns_topic" "${tf}" {`,
        `  name              = "${ctx.prefix}-${tf.replace(/_/g, "-")}"`,
        // Budget floor: the AWS-managed alias/aws/sns key (free). Balanced+: a CMK
        // granting the cloudwatch + sns principals (emitted in baseline.ts).
        `  kms_master_key_id = ${ctx.paidSecurity ? "aws_kms_key.sns.arn" : '"alias/aws/sns"'}`,
        `}`,
        ``,
        `resource "aws_sns_topic_policy" "${tf}" {`,
        `  arn    = ${arn}`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "AllowAccountPublish",
                Effect: "Allow",
                Principal: { AWS: raw('"arn:${local.partition}:iam::${local.account_id}:root"') },
                Action: "sns:Publish",
                Resource: raw(arn),
              },
              {
                Sid: "AllowCloudWatchAlarms",
                Effect: "Allow",
                Principal: { Service: "cloudwatch.amazonaws.com" },
                Action: "sns:Publish",
                Resource: raw(arn),
                Condition: { StringEquals: { "aws:SourceAccount": raw("local.account_id") } },
              },
              {
                Sid: "DenyNonTLS",
                Effect: "Deny",
                Principal: "*",
                Action: "sns:Publish",
                Resource: raw(arn),
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ]),
          ),
        )}`,
        `}`,
        ``,
        ...subscription,
      ].join("\n"),
    },
  ];
}

export function emitXray(node: ArchitectureNode, _ctx: EmitCtx): HclBlock[] {
  return [
    {
      section: "X-Ray",
      dedupeKey: "xray-note",
      hcl: [
        `# X-Ray needs no infrastructure resource — tracing is enabled per-function`,
        `# (tracing_config) and per-instance, and the xray:Put* IAM grants on each`,
        `# compute role (derived from the trace edges) cover it. (${node.id})`,
      ].join("\n"),
    },
  ];
}

export function emitCloudtrail(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  return [
    {
      section: "CloudTrail",
      hcl: [
        `resource "aws_s3_bucket" "${tf}_logs" {`,
        `  bucket_prefix = "${ctx.prefix}-cloudtrail-"`,
        `  force_destroy = false`,
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
        `resource "aws_s3_bucket_policy" "${tf}_logs" {`,
        `  bucket = aws_s3_bucket.${tf}_logs.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "AWSCloudTrailAclCheck",
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: "s3:GetBucketAcl",
                Resource: raw(`aws_s3_bucket.${tf}_logs.arn`),
              },
              {
                Sid: "AWSCloudTrailWrite",
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: "s3:PutObject",
                Resource: raw(`"\${aws_s3_bucket.${tf}_logs.arn}/AWSLogs/\${local.account_id}/*"`),
                Condition: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" } },
              },
            ]),
          ),
        )}`,
        `}`,
        ``,
        `resource "aws_cloudwatch_log_group" "${tf}" {`,
        `  name              = "/aws/cloudtrail/${ctx.prefix}"`,
        `  retention_in_days = 90`,
        ...cwLogsKmsLine(ctx),
        `}`,
        ``,
        `data "aws_iam_policy_document" "${tf}_assume" {`,
        `  statement {`,
        `    actions = ["sts:AssumeRole"]`,
        `    principals {`,
        `      type        = "Service"`,
        `      identifiers = ["cloudtrail.amazonaws.com"]`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `resource "aws_iam_role" "${tf}_cw" {`,
        `  name               = "${ctx.prefix}-cloudtrail-cw"`,
        `  assume_role_policy = data.aws_iam_policy_document.${tf}_assume.json`,
        `}`,
        ``,
        `resource "aws_iam_role_policy" "${tf}_cw" {`,
        `  name = "cloudtrail-cw"`,
        `  role = aws_iam_role.${tf}_cw.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: raw(`"\${aws_cloudwatch_log_group.${tf}.arn}:*"`),
              },
            ]),
          ),
        )}`,
        `}`,
        ``,
        `resource "aws_cloudtrail" "${tf}" {`,
        `  name                          = "${ctx.prefix}-trail"`,
        `  s3_bucket_name                = aws_s3_bucket.${tf}_logs.bucket`,
        // Budget/balanced floor: a single-region management-event trail (free management
        // events). Resilient (or any tier under compliance): a multi-region trail.
        `  is_multi_region_trail         = ${ctx.multiRegionTrail}`,
        `  enable_log_file_validation    = true`,
        `  include_global_service_events = true`,
        `  cloud_watch_logs_group_arn    = "\${aws_cloudwatch_log_group.${tf}.arn}:*"`,
        `  cloud_watch_logs_role_arn     = aws_iam_role.${tf}_cw.arn`,
        `  depends_on                    = [aws_s3_bucket_policy.${tf}_logs]`,
        `}`,
      ].join("\n"),
    },
  ];
}
