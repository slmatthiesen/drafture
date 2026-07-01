/**
 * Compute emitters — the EC2 application box (+ the minimal public-subnet network
 * it needs), the self-managed Postgres data volume that rides ON that box, and
 * Lambda functions (+ their CMK-encrypted log group). IAM roles, instance
 * profiles, and security groups are derived from the EDGE list in glue.ts, so these
 * emitters reference those addresses by deterministic name and never invent wiring.
 */
import type { ArchitectureNode } from "../../../schema/architecture.js";
import { colocatedHost, cwLogsKmsLine, lambdaNeedsVpc, ref, type EmitCtx } from "../context.js";
import type { HclBlock } from "../hcl.js";

const tag = (node: ArchitectureNode, kw: string): boolean =>
  node.security.some((s) => s.toLowerCase().includes(kw));

/** Pull an instance type out of "EC2 (t4g.medium)" — default a small ARM box. */
function instanceType(node: ArchitectureNode): string {
  const m = /\b([a-z]\d[a-z]?g?\.[a-z0-9]+)\b/.exec(`${node.awsService} ${node.role}`.toLowerCase());
  return m ? m[1]! : "t4g.small";
}

export function emitEc2(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const blocks: HclBlock[] = [];

  // The VPC + public subnet are emitted by networking.ts (it owns the VPC shape so a
  // tier that ALSO has private workloads gets the multi-AZ layout). The box lands in
  // the first public subnet.
  blocks.push({
    section: `EC2 — ${node.role}`,
    hcl: [
      `resource "aws_instance" "${tf}" {`,
      `  ami                    = var.ami_id`,
      `  instance_type          = "${instanceType(node)}"`,
      `  subnet_id              = aws_subnet.public_a.id`,
      `  vpc_security_group_ids = [aws_security_group.${tf}.id]`,
      `  iam_instance_profile   = aws_iam_instance_profile.${tf}.name`,
      ``,
      `  # IMDSv2 required (no v1 fallback).`,
      `  metadata_options {`,
      `    http_endpoint               = "enabled"`,
      `    http_tokens                 = "required"`,
      `    http_put_response_hop_limit = 1`,
      `  }`,
      ``,
      `  root_block_device {`,
      `    volume_type = "gp3"`,
      `    volume_size = 20`,
      `    encrypted   = true`,
      // Budget floor: AWS-managed aws/ebs key (free). Balanced+/compliance: a CMK.
      ...(ctx.paidSecurity ? [`    kms_key_id  = aws_kms_key.main.arn`] : []),
      `  }`,
      ``,
      `  tags = { Name = "${ctx.prefix}-${tf.replace(/_/g, "-")}" }`,
      `}`,
    ].join("\n"),
  });

  return blocks;
}

export function emitPostgres(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const host = colocatedHost(ctx, node.id);
  const blocks: HclBlock[] = [
    {
      section: `Self-managed PostgreSQL — ${node.role}`,
      hcl: [
        `# Self-managed Postgres rides on the EC2 box (localhost-bound, not network-`,
        `# exposed). Its data lives on a dedicated KMS-encrypted gp3 EBS volume.`,
        `resource "aws_ebs_volume" "${tf}" {`,
        `  availability_zone = "${ctx.region}a"`,
        `  size              = 50`,
        `  type              = "gp3"`,
        `  encrypted         = true`,
        ...(ctx.paidSecurity ? [`  kms_key_id        = aws_kms_key.main.arn`] : []),
        `  tags              = { Name = "${ctx.prefix}-${tf.replace(/_/g, "-")}" }`,
        `}`,
      ].join("\n"),
    },
  ];
  if (host) {
    blocks.push({
      section: `Self-managed PostgreSQL — ${node.role}`,
      hcl: [
        `resource "aws_volume_attachment" "${tf}" {`,
        `  device_name = "/dev/sdf"`,
        `  volume_id   = aws_ebs_volume.${tf}.id`,
        `  instance_id = ${ref.instance(ctx, host.id)}.id`,
        `}`,
      ].join("\n"),
    });
  }
  return blocks;
}

/** Pull a volume size in GB out of "EBS (gp3, 20 GB)" — default a small 20 GB gp3. */
function volumeSizeGb(node: ArchitectureNode): number {
  const m = /(\d+)\s*gb/i.exec(`${node.awsService} ${node.role}`);
  return m ? Number(m[1]) : 20;
}

/**
 * A standalone durable EBS data volume for a stateful box (e.g. the SQLite file behind
 * a self-hosted app). Mirrors the self-managed-Postgres volume: a KMS-encrypted gp3
 * volume kept OFF the root device so on-disk state survives instance replacement, plus
 * a daily DLM snapshot policy (emitted once per tier) for point-in-time recovery — the
 * durability a stateful design is meaningless without.
 */
export function emitEbs(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const host = colocatedHost(ctx, node.id);
  const section = `EBS — ${node.role}`;
  const blocks: HclBlock[] = [
    {
      section,
      hcl: [
        `# Durable gp3 data volume, kept off the root device so on-disk state (a SQLite`,
        `# file, an upload spool) survives instance replacement. Snapshotted daily below.`,
        `resource "aws_ebs_volume" "${tf}" {`,
        `  availability_zone = "${ctx.region}a"`,
        `  size              = ${volumeSizeGb(node)}`,
        `  type              = "gp3"`,
        `  encrypted         = true`,
        ...(ctx.paidSecurity ? [`  kms_key_id        = aws_kms_key.main.arn`] : []),
        `  tags              = { Name = "${ctx.prefix}-${tf.replace(/_/g, "-")}", Backup = "daily" }`,
        `}`,
      ].join("\n"),
    },
  ];

  if (host) {
    blocks.push({
      section,
      hcl: [
        `resource "aws_volume_attachment" "${tf}" {`,
        `  device_name = "/dev/sdf"`,
        `  volume_id   = aws_ebs_volume.${tf}.id`,
        `  instance_id = ${ref.instance(ctx, host.id)}.id`,
        `}`,
      ].join("\n"),
    });
  }

  // One DLM policy covers every Backup=daily volume in the tier — emitted once (deduped)
  // regardless of how many EBS nodes route here.
  blocks.push({
    section: `EBS — daily snapshots`,
    dedupeKey: "ebs-dlm-daily",
    hcl: [
      `# Daily automated snapshots of every volume tagged Backup=daily (single-AZ data`,
      `# volumes have no built-in redundancy — snapshots are the recovery path).`,
      `resource "aws_iam_role" "dlm" {`,
      `  name = "${ctx.prefix}-dlm-role"`,
      `  assume_role_policy = jsonencode({`,
      `    Version = "2012-10-17"`,
      `    Statement = [{`,
      `      Effect    = "Allow"`,
      `      Principal = { Service = "dlm.amazonaws.com" }`,
      `      Action    = "sts:AssumeRole"`,
      `    }]`,
      `  })`,
      `}`,
      ``,
      `resource "aws_iam_role_policy_attachment" "dlm" {`,
      `  role       = aws_iam_role.dlm.name`,
      `  policy_arn = "arn:\${local.partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"`,
      `}`,
      ``,
      `resource "aws_dlm_lifecycle_policy" "ebs_daily" {`,
      `  description        = "${ctx.prefix} daily EBS snapshot"`,
      `  execution_role_arn = aws_iam_role.dlm.arn`,
      `  state              = "ENABLED"`,
      ``,
      `  policy_details {`,
      `    resource_types = ["VOLUME"]`,
      `    target_tags    = { Backup = "daily" }`,
      ``,
      `    schedule {`,
      `      name = "daily-0200"`,
      `      create_rule {`,
      `        interval      = 24`,
      `        interval_unit = "HOURS"`,
      `        times         = ["02:00"]`,
      `      }`,
      `      retain_rule {`,
      `        count = 7`,
      `      }`,
      `      copy_tags = true`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n"),
  });

  return blocks;
}

export function emitLambda(node: ArchitectureNode, ctx: EmitCtx): HclBlock[] {
  const tf = ctx.tf(node.id);
  const surface = `${node.awsService} ${node.role}`.toLowerCase();
  const runtime = surface.includes("python") ? "python3.12" : "nodejs20.x";
  const memMatch = /(\d{3,5})\s*mb/.exec(surface);
  const memory = memMatch ? Number(memMatch[1]) : 512;
  const tracesXray = ctx.out(node.id).some((e) => {
    const to = ctx.byId(e.to);
    return to && ctx.keyOf(to) === "xray";
  }) || tag(node, "x-ray") || tag(node, "trace");
  const reserved = tag(node, "reserved concurrency");
  const inVpc = lambdaNeedsVpc(ctx, node);

  const blocks: HclBlock[] = [
    {
      section: `Lambda — ${node.role}`,
      hcl: [
        `resource "aws_lambda_function" "${tf}" {`,
        `  function_name = "${ctx.prefix}-${tf.replace(/_/g, "-")}"`,
        `  role          = ${ref.roleArn(ctx, node.id)}`,
        `  # Placeholder package — replace with your real deployment artifact.`,
        `  filename      = "${tf}_placeholder.zip"`,
        `  handler       = "index.handler"`,
        `  runtime       = "${runtime}"`,
        `  architectures = ["arm64"]`,
        `  memory_size   = ${memory}`,
        `  timeout       = 300`,
        ...(reserved ? [`  reserved_concurrent_executions = 10`] : []),
        ...(tracesXray ? [``, `  tracing_config {`, `    mode = "Active"`, `  }`] : []),
        ...(inVpc
          ? [
              ``,
              `  # VPC-attached — it reaches a VPC-bound store (RDS/ElastiCache), so it runs`,
              `  # in the private subnets and egresses through NAT.`,
              `  vpc_config {`,
              `    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]`,
              `    security_group_ids = [aws_security_group.${tf}.id]`,
              `  }`,
            ]
          : [
              `  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly`,
              `  # (Secrets Manager, S3) with no NAT, the cost-honest default.`,
            ]),
        `}`,
        ``,
        `resource "aws_cloudwatch_log_group" "${tf}" {`,
        `  name              = "/aws/lambda/${ctx.prefix}-${tf.replace(/_/g, "-")}"`,
        `  retention_in_days = 30`,
        ...cwLogsKmsLine(ctx),
        `}`,
      ].join("\n"),
    },
  ];

  if (inVpc) {
    blocks.push({
      section: `Lambda — ${node.role}`,
      hcl: [
        `resource "aws_security_group" "${tf}" {`,
        `  name        = "${ctx.prefix}-${tf.replace(/_/g, "-")}-sg"`,
        `  description = "Egress for VPC-attached Lambda ${node.role}"`,
        `  vpc_id      = aws_vpc.main.id`,
        `  egress {`,
        `    description = "All outbound (NAT + VPC services)"`,
        `    from_port   = 0`,
        `    to_port     = 0`,
        `    protocol    = "-1"`,
        `    cidr_blocks = ["0.0.0.0/0"]`,
        `  }`,
        `  tags = { Name = "${ctx.prefix}-${tf.replace(/_/g, "-")}-sg" }`,
        `}`,
      ].join("\n"),
    });
  }

  return blocks;
}
