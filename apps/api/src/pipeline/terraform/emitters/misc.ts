/**
 * Smaller resilient-tier emitters: NAT (absorbed by networking — a note here keeps
 * the node "covered"), CloudWatch Dashboard, CloudWatch Anomaly Detection (a note —
 * it's an alarm feature, no standalone resource), SQS (queue + DLQ redrive +
 * EventBridge send policy + the consumer Lambda's event-source mapping & receive
 * grant), and the EventBridge bus (+ a rule/target per outgoing edge). All wiring is
 * derived from the typed edges.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { ref, type EmitCtx } from "../context.js";
import { type HclBlock, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
const dash = (tf: string): string => tf.replace(/_/g, "-");

/** NAT is emitted by networking.ts (it owns the VPC shape). The node maps to a note
 *  so coverage counts it instead of routing the whole tier to the LLM fallback. */
export function emitNat(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  return [
    {
      section: "Networking",
      dedupeKey: `nat-note-${ctx.tf(node.id)}`,
      hcl: `# NAT gateway '${node.id}' (${node.role}) is emitted in the NETWORKING section\n# (aws_nat_gateway) — it's part of the VPC egress layout, not a standalone node.`,
    },
  ];
}

export function emitCloudwatchDashboard(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  // A minimal, valid dashboard. The widget set is a starting point — extend with the
  // golden-signal metrics for the services this tier actually runs.
  const body = jsonencode({
    widgets: [
      {
        type: "text",
        x: 0,
        y: 0,
        width: 24,
        height: 2,
        properties: { markdown: `# ${ctx.prefix} — golden signals (${node.role})` },
      },
    ],
  });
  return [
    {
      section: "CloudWatch Dashboard",
      hcl: [
        `resource "aws_cloudwatch_dashboard" "${tf}" {`,
        `  dashboard_name = "${ctx.prefix}-${dash(tf)}"`,
        `  dashboard_body = ${indentPolicy(body)}`,
        `}`,
      ].join("\n"),
    },
  ];
}

export function emitCloudwatchAnomaly(node: ArchitectureNode, _ctx: EmitCtx): HclBlock[] {
  return [
    {
      section: "CloudWatch Alarms",
      dedupeKey: `anomaly-note-${node.id}`,
      hcl: [
        `# Anomaly detection '${node.id}' (${node.role}) is a CloudWatch feature, not a`,
        `# standalone resource: add a band-based aws_cloudwatch_metric_alarm with a`,
        `# metric_query referencing ANOMALY_DETECTION_BAND() on your key SLO metric.`,
      ].join("\n"),
    },
  ];
}

// --- SQS ---------------------------------------------------------------------

export function emitSqs(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `SQS — ${node.role}`;
  const blocks: HclBlock[] = [];

  // A redrive edge (this queue → another SQS) names this queue's DLQ.
  const dlq = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .find((n) => n && ctx.keyOf(n) === "sqs");

  const queueLines = [
    `resource "aws_sqs_queue" "${tf}" {`,
    `  name                       = "${ctx.prefix}-${dash(tf)}"`,
    `  sqs_managed_sse_enabled    = true`,
    `  message_retention_seconds  = 1209600`,
    `  visibility_timeout_seconds = 300`,
  ];
  if (dlq) {
    queueLines.push(
      `  redrive_policy = jsonencode({`,
      `    deadLetterTargetArn = aws_sqs_queue.${ctx.tf(dlq.id)}.arn`,
      `    maxReceiveCount     = 5`,
      `  })`,
    );
  }
  queueLines.push(`}`);
  blocks.push({ section, hcl: queueLines.join("\n") });

  // If an EventBridge bus targets this queue, grant the events principal SendMessage
  // (scoped to the rule that delivers here) — otherwise EventBridge can't enqueue.
  const busSource = ctx
    .in(node.id)
    .map((e) => ctx.byId(e.from))
    .find((n) => n && ctx.keyOf(n) === "eventbridge-bus");
  if (busSource) {
    const ruleArn = `aws_cloudwatch_event_rule.${ctx.tf(busSource.id)}_${tf}.arn`;
    blocks.push({
      section,
      hcl: [
        `resource "aws_sqs_queue_policy" "${tf}" {`,
        `  queue_url = aws_sqs_queue.${tf}.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "AllowEventBridge",
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: raw(`aws_sqs_queue.${tf}.arn`),
                Condition: { ArnEquals: { "aws:SourceArn": raw(ruleArn) } },
              },
            ]),
          ),
        )}`,
        `}`,
      ].join("\n"),
    });
  }

  // If this queue is an event source for a Lambda, wire the mapping + the consumer's
  // receive grant (an INCOMING edge to the Lambda, which the outgoing-edge IAM misses).
  const consumer = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .find((n) => n && ctx.keyOf(n) === "lambda");
  if (consumer) {
    const ctf = ctx.tf(consumer.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_lambda_event_source_mapping" "${tf}_${ctf}" {`,
        `  event_source_arn = aws_sqs_queue.${tf}.arn`,
        `  function_name    = ${ref.lambda(ctx, consumer.id)}.arn`,
        `  batch_size       = 10`,
        `}`,
        ``,
        `resource "aws_iam_role_policy" "${ctf}_consume_${tf}" {`,
        `  name = "${ctx.prefix}-${dash(ctf)}-consume-${dash(tf)}"`,
        `  role = ${ref.role(ctx, consumer.id)}.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "ConsumeQueue",
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: raw(`aws_sqs_queue.${tf}.arn`),
              },
            ]),
          ),
        )}`,
        `}`,
      ].join("\n"),
    });
  }

  return blocks;
}

// --- EventBridge bus ---------------------------------------------------------

export function emitEventbridgeBus(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `EventBridge bus — ${node.role}`;
  const blocks: HclBlock[] = [
    {
      section,
      hcl: [
        `resource "aws_cloudwatch_event_bus" "${tf}" {`,
        `  name = "${ctx.prefix}-${dash(tf)}"`,
        `}`,
      ].join("\n"),
    },
  ];

  // One rule + target per outgoing edge to an SQS queue (the pipeline fan-out).
  for (const edge of ctx.out(node.id)) {
    const target = ctx.byId(edge.to);
    if (!target || ctx.keyOf(target) !== "sqs") continue;
    const ttf = ctx.tf(target.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_cloudwatch_event_rule" "${tf}_${ttf}" {`,
        `  name           = "${ctx.prefix}-${dash(tf)}-${dash(ttf)}"`,
        `  event_bus_name = aws_cloudwatch_event_bus.${tf}.name`,
        `  event_pattern  = jsonencode({`,
        `    source = ["${ctx.prefix}.pipeline"]`,
        `  })`,
        `}`,
        ``,
        `resource "aws_cloudwatch_event_target" "${tf}_${ttf}" {`,
        `  rule           = aws_cloudwatch_event_rule.${tf}_${ttf}.name`,
        `  event_bus_name = aws_cloudwatch_event_bus.${tf}.name`,
        `  arn            = aws_sqs_queue.${ttf}.arn`,
        `}`,
      ].join("\n"),
    });
  }

  return blocks;
}
