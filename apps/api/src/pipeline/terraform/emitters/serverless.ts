/**
 * Serverless-core emitters — DynamoDB and API Gateway (HTTP API), the two services
 * almost every serverless-first design reaches for. Both wire from the typed edges:
 * an API Gateway route + integration + invoke permission per `apigw → lambda` edge;
 * a DynamoDB table that turns on Streams + a Lambda event-source mapping (and the
 * consumer's stream-read grant) per `dynamo → lambda` edge. Tables encrypt with the
 * general-purpose CMK and enable point-in-time recovery by default.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { ref, type EmitCtx } from "../context.js";
import { type HclBlock, jsonencode, policyDoc, raw } from "../hcl.js";

const indentPolicy = (json: string): string =>
  json.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
const dash = (tf: string): string => tf.replace(/_/g, "-");
const isGlobal = (node: ArchitectureNode): boolean => /global table/i.test(`${node.awsService} ${node.role}`);

// --- DynamoDB ----------------------------------------------------------------

export function emitDynamo(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `DynamoDB — ${node.role}`;
  const global = isGlobal(node);

  // A dynamo → lambda edge is a DynamoDB Streams trigger; that requires the stream.
  const streamConsumers = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "lambda");
  const streamed = global || streamConsumers.length > 0;

  const tableLines = [
    `resource "aws_dynamodb_table" "${tf}" {`,
    `  name         = "${ctx.prefix}-${dash(tf)}"`,
    `  billing_mode = "PAY_PER_REQUEST"`,
    `  hash_key     = "id"`,
    `  attribute {`,
    `    name = "id"`,
    `    type = "S"`,
    `  }`,
    `  server_side_encryption {`,
    `    enabled     = true`,
    `    kms_key_arn = aws_kms_key.main.arn`,
    `  }`,
    `  point_in_time_recovery {`,
    `    enabled = true`,
    `  }`,
    ...(streamed ? [`  stream_enabled   = true`, `  stream_view_type = "NEW_AND_OLD_IMAGES"`] : []),
    ...(global
      ? [
          `  # Global Tables v2 — add a replica per extra region (its own CMK if you use one).`,
          `  replica {`,
          `    region_name = "us-west-2"`,
          `  }`,
        ]
      : []),
    `}`,
  ];
  const blocks: HclBlock[] = [{ section, hcl: tableLines.join("\n") }];

  // Each stream-consumer Lambda gets an event-source mapping + the stream-read grant
  // (an INCOMING edge to the Lambda, which the outgoing-edge IAM derivation misses).
  for (const consumer of streamConsumers) {
    const ctf = ctx.tf(consumer.id);
    blocks.push({
      section,
      hcl: [
        `resource "aws_lambda_event_source_mapping" "${tf}_${ctf}" {`,
        `  event_source_arn  = aws_dynamodb_table.${tf}.stream_arn`,
        `  function_name     = ${ref.lambda(ctx, consumer.id)}.arn`,
        `  starting_position = "LATEST"`,
        `  batch_size        = 100`,
        `}`,
        ``,
        `resource "aws_iam_role_policy" "${ctf}_stream_${tf}" {`,
        `  name = "${ctx.prefix}-${dash(ctf)}-stream-${dash(tf)}"`,
        `  role = ${ref.role(ctx, consumer.id)}.id`,
        `  policy = ${indentPolicy(
          jsonencode(
            policyDoc([
              {
                Sid: "ReadStream",
                Effect: "Allow",
                Action: ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"],
                Resource: raw(`"\${aws_dynamodb_table.${tf}.arn}/stream/*"`),
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

// --- API Gateway (HTTP API, v2) ----------------------------------------------

export function emitApiGateway(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const section = `API Gateway — ${node.role}`;
  const lambdaTargets = ctx
    .out(node.id)
    .map((e) => ctx.byId(e.to))
    .filter((n): n is ArchitectureNode => !!n && ctx.keyOf(n) === "lambda");

  const blocks: HclBlock[] = [
    {
      section,
      hcl: [
        `resource "aws_apigatewayv2_api" "${tf}" {`,
        `  name          = "${ctx.prefix}-${dash(tf)}"`,
        `  protocol_type = "HTTP"`,
        `}`,
        ``,
        `resource "aws_cloudwatch_log_group" "${tf}" {`,
        `  name              = "/aws/apigw/${ctx.prefix}-${dash(tf)}"`,
        `  retention_in_days = 30`,
        `  kms_key_id        = aws_kms_key.cw_logs.arn`,
        `}`,
        ``,
        `resource "aws_apigatewayv2_stage" "${tf}" {`,
        `  api_id      = aws_apigatewayv2_api.${tf}.id`,
        `  name        = "$default"`,
        `  auto_deploy = true`,
        `  access_log_settings {`,
        `    destination_arn = aws_cloudwatch_log_group.${tf}.arn`,
        `    format = jsonencode({`,
        `      requestId    = "$context.requestId"`,
        `      routeKey     = "$context.routeKey"`,
        `      status       = "$context.status"`,
        `      responseTime = "$context.responseLatency"`,
        `    })`,
        `  }`,
        `}`,
      ].join("\n"),
    },
  ];

  // One integration + route + invoke permission per backing Lambda. The first claims
  // the catch-all $default route; extras get a path prefix.
  lambdaTargets.forEach((t, i) => {
    const ltf = ctx.tf(t.id);
    const routeKey = i === 0 ? "$default" : `ANY /${dash(ltf)}/{proxy+}`;
    blocks.push({
      section,
      hcl: [
        `resource "aws_apigatewayv2_integration" "${tf}_${ltf}" {`,
        `  api_id                 = aws_apigatewayv2_api.${tf}.id`,
        `  integration_type       = "AWS_PROXY"`,
        `  integration_uri        = ${ref.lambda(ctx, t.id)}.invoke_arn`,
        `  payload_format_version = "2.0"`,
        `}`,
        ``,
        `resource "aws_apigatewayv2_route" "${tf}_${ltf}" {`,
        `  api_id    = aws_apigatewayv2_api.${tf}.id`,
        `  route_key = "${routeKey}"`,
        `  target    = "integrations/\${aws_apigatewayv2_integration.${tf}_${ltf}.id}"`,
        `}`,
        ``,
        `resource "aws_lambda_permission" "${tf}_${ltf}" {`,
        `  statement_id  = "AllowAPIGWInvoke_${ltf}"`,
        `  action        = "lambda:InvokeFunction"`,
        `  function_name = ${ref.lambda(ctx, t.id)}.function_name`,
        `  principal     = "apigateway.amazonaws.com"`,
        `  source_arn    = "\${aws_apigatewayv2_api.${tf}.execution_arn}/*/*"`,
        `}`,
      ].join("\n"),
    });
  });

  return blocks;
}
