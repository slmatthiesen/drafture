/**
 * EventBridge Scheduler — a clock that invokes the Lambda(s) its edges target. It
 * emits its own assume-role + invoke policy scoped to exactly those functions, one
 * `aws_scheduler_schedule` per target, and the `aws_lambda_permission` that lets
 * the scheduler principal invoke each (the permission a scheduler→lambda wiring
 * silently needs). Targets come from the scheduler→lambda edges — never invented.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { ref, type EmitCtx } from "../context.js";
import { type HclBlock, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");

export function emitScheduler(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const targets = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "lambda");
  if (targets.length === 0) return [];

  const blocks: HclBlock[] = [];
  blocks.push({
    section: "EventBridge Scheduler",
    hcl: [
      `data "aws_iam_policy_document" "${tf}_assume" {`,
      `  statement {`,
      `    actions = ["sts:AssumeRole"]`,
      `    principals {`,
      `      type        = "Service"`,
      `      identifiers = ["scheduler.amazonaws.com"]`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `resource "aws_iam_role" "${tf}" {`,
      `  name               = "${ctx.prefix}-${tf.replace(/_/g, "-")}"`,
      `  assume_role_policy = data.aws_iam_policy_document.${tf}_assume.json`,
      `}`,
      ``,
      `resource "aws_iam_role_policy" "${tf}_invoke" {`,
      `  name = "${ctx.prefix}-${tf.replace(/_/g, "-")}-invoke"`,
      `  role = aws_iam_role.${tf}.id`,
      `  policy = ${indentPolicy(
        jsonencode(
          policyDoc([
            {
              Sid: "InvokeTargets",
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: targets.map((t) => raw(ref.lambdaArn(ctx, t.id))),
            },
          ]),
        ),
      )}`,
      `}`,
    ].join("\n"),
  });

  targets.forEach((t, i) => {
    const ttf = ctx.tf(t.id);
    // Stagger default schedules so two targets don't collide on the same cron minute.
    const hour = 2 + i;
    blocks.push({
      section: "EventBridge Scheduler",
      hcl: [
        `resource "aws_scheduler_schedule" "${tf}_${ttf}" {`,
        `  name       = "${ctx.prefix}-${tf.replace(/_/g, "-")}-${ttf.replace(/_/g, "-")}"`,
        `  group_name = "default"`,
        `  flexible_time_window { mode = "OFF" }`,
        `  schedule_expression = "cron(0 ${hour} * * ? *)"`,
        `  target {`,
        `    arn      = ${ref.lambdaArn(ctx, t.id)}`,
        `    role_arn = ${ref.roleArn(ctx, node.id)}`,
        `  }`,
        `}`,
        ``,
        `resource "aws_lambda_permission" "${tf}_${ttf}" {`,
        `  statement_id  = "AllowSchedulerInvoke_${ttf}"`,
        `  action        = "lambda:InvokeFunction"`,
        `  function_name = ${ref.lambda(ctx, t.id)}.function_name`,
        `  principal     = "scheduler.amazonaws.com"`,
        `  source_arn    = aws_scheduler_schedule.${tf}_${ttf}.arn`,
        `}`,
      ].join("\n"),
    });
  });

  return blocks;
}
