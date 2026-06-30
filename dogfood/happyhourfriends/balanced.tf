##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# REFERENCE-ONLY Terraform for the BALANCED tier — generated
# DETERMINISTICALLY from the design graph. Human review + hardening required.
# =============================================================================

# =============================================================================
# PROVIDERS & VARIABLES
# =============================================================================

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ACM certs and WAF web ACLs for CloudFront MUST live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "domain_name" {
  type        = string
  description = "Primary domain served by CloudFront, e.g. example.com."
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted-zone id for domain_name (ACM DNS validation + alias records)."
}

# A CloudFront https-only origin must present a trusted-CA cert for its hostname.
# NEVER an EC2 instance public DNS / raw ALB DNS name (no cert, churns on replace)
# — supply a custom domain (ALB or EIP + Route53) with an ACM cert. (rule:
# cloudfront-origin-tls)
variable "origin_domain" {
  type        = string
  description = "Custom domain (ALB / EIP + Route53) for the dynamic origin — MUST have a TLS cert."
}

variable "alb_certificate_arn" {
  type        = string
  description = "Regional ACM certificate ARN for the ALB HTTPS listener (origin_domain)."
}

variable "ops_email" {
  type        = string
  description = "Destination for SNS ops alerts."
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = var.aws_region
}

# =============================================================================
# KMS KEYS
# =============================================================================

# General-purpose CMK — S3 buckets, EBS volumes, Secrets Manager.
resource "aws_kms_key" "main" {
  description             = "balanced main CMK — S3, EBS, Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowSecretsManager"
        Effect = "Allow"
        Principal = {
          Service = "secretsmanager.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:CreateGrant",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/balanced-main"
  target_key_id = aws_kms_key.main.key_id
}

# CloudWatch Logs CMK — the Logs service principal MUST be granted, keyed off
# the LITERAL region (not ${local.region}), or PutLogEvents fails at runtime.
resource "aws_kms_key" "cw_logs" {
  description             = "balanced CloudWatch Logs CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.us-east-1.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:us-east-1:${local.account_id}:*"
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "cw_logs" {
  name          = "alias/balanced-cw-logs"
  target_key_id = aws_kms_key.cw_logs.key_id
}

# SNS CMK — a CloudWatch alarm publishing to an encrypted topic needs BOTH the
# cloudwatch and sns service principals, or alarm publish fails at runtime.
resource "aws_kms_key" "sns" {
  description             = "balanced SNS ops-alert CMK"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "kms:*"
        Resource = "*"
      },
      {
        Sid = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      },
      {
        Sid = "AllowSNSService"
        Effect = "Allow"
        Principal = {
          Service = "sns.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "sns" {
  name          = "alias/balanced-sns"
  target_key_id = aws_kms_key.sns.key_id
}

# =============================================================================
# NETWORKING
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "balanced-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "balanced-igw" }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "balanced-public-a" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "balanced-public-rt" }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true
  tags                    = { Name = "balanced-public-b" }
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = "us-east-1a"
  tags              = { Name = "balanced-private-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.11.0/24"
  availability_zone = "us-east-1b"
  tags              = { Name = "balanced-private-b" }
}

resource "aws_eip" "nat_a" {
  domain = "vpc"
  tags   = { Name = "balanced-nat-a" }
}

resource "aws_nat_gateway" "a" {
  allocation_id = aws_eip.nat_a.id
  subnet_id     = aws_subnet.public_a.id
  tags          = { Name = "balanced-nat-a" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private_a" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.a.id
  }
  tags = { Name = "balanced-private-a-rt" }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private_a.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private_a.id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# NAT gateway 'nat_gw' (private subnet egress) is emitted in the NETWORKING section
# (aws_nat_gateway) — it's part of the VPC egress layout, not a standalone node.

# =============================================================================
# IAM
# =============================================================================

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# =============================================================================
# IAM — DATA RECONCILIATION CRON
# =============================================================================

resource "aws_iam_role" "cron_lambda" {
  name               = "balanced-cron-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "cron_lambda_managed" {
  role       = aws_iam_role.cron_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "cron_lambda_inline" {
  name = "balanced-cron-lambda-inline"
  role = aws_iam_role.cron_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "Secret_secrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.secrets.arn
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# IAM — HEADLESS CHROMIUM RENDERER
# =============================================================================

resource "aws_iam_role" "render_lambda" {
  name               = "balanced-render-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "render_lambda_managed" {
  role       = aws_iam_role.render_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "render_lambda_inline" {
  name = "balanced-render-lambda-inline"
  role = aws_iam_role.render_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "S3_s3_renders"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.s3_renders.arn,
          "${aws_s3_bucket.s3_renders.arn}/*"
        ]
      },
      {
        Sid = "XRayWrite"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets"
        ]
        Resource = "*"
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# IAM — NIGHTLY PG_DUMP SCHEDULER
# =============================================================================

resource "aws_iam_role" "backup_lambda" {
  name               = "balanced-backup-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "backup_lambda_managed" {
  role       = aws_iam_role.backup_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "backup_lambda_inline" {
  name = "balanced-backup-lambda-inline"
  role = aws_iam_role.backup_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "S3_s3_backups"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.s3_backups.arn,
          "${aws_s3_bucket.s3_backups.arn}/*"
        ]
      },
      {
        Sid = "Secret_secrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.secrets.arn
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# =============================================================================
# S3 — DB BACKUP STORE
# =============================================================================

resource "aws_s3_bucket" "s3_backups" {
  bucket_prefix = "balanced-s3-backups-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "s3_backups" {
  bucket = aws_s3_bucket.s3_backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "s3_backups" {
  bucket                  = aws_s3_bucket.s3_backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "s3_backups" {
  bucket = aws_s3_bucket.s3_backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_policy" "s3_backups" {
  bucket = aws_s3_bucket.s3_backups.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.s3_backups.arn,
          "${aws_s3_bucket.s3_backups.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — ISR ASSETS + MEDIA STORE
# =============================================================================

resource "aws_s3_bucket" "s3_assets" {
  bucket_prefix = "balanced-s3-assets-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "s3_assets" {
  bucket = aws_s3_bucket.s3_assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "s3_assets" {
  bucket                  = aws_s3_bucket.s3_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "s3_assets" {
  bucket = aws_s3_bucket.s3_assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_policy" "s3_assets" {
  bucket = aws_s3_bucket.s3_assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.s3_assets.arn,
          "${aws_s3_bucket.s3_assets.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action = "s3:GetObject"
        Resource = "${aws_s3_bucket.s3_assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.cf.arn
          }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — RENDER OUTPUT STORE
# =============================================================================

resource "aws_s3_bucket" "s3_renders" {
  bucket_prefix = "balanced-s3-renders-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "s3_renders" {
  bucket = aws_s3_bucket.s3_renders.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "s3_renders" {
  bucket                  = aws_s3_bucket.s3_renders.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "s3_renders" {
  bucket = aws_s3_bucket.s3_renders.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.s3_renders.arn,
          "${aws_s3_bucket.s3_renders.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# =============================================================================
# SECRETS MANAGER — CREDENTIALS STORE
# =============================================================================

# No rotation Lambda is provided, so the rotation resource is intentionally
# OMITTED — a null rotation_lambda_arn is invalid (rule: secretsmanager-rotation-lambda).
resource "aws_secretsmanager_secret" "secrets" {
  name       = "balanced/secrets"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "secrets" {
  secret_id     = aws_secretsmanager_secret.secrets.id
  secret_string = jsonencode({
    username = "REPLACE_ME"
    password = "REPLACE_ME" # inject out-of-band; do not commit a real secret
  })
}

# =============================================================================
# LAMBDA — DATA RECONCILIATION CRON
# =============================================================================

resource "aws_lambda_function" "cron_lambda" {
  function_name = "balanced-cron-lambda"
  role          = aws_iam_role.cron_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "cron_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300

  # VPC-attached — it reaches a VPC-bound store (RDS/ElastiCache), so it runs
  # in the private subnets and egresses through NAT.
  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.cron_lambda.id]
  }
}

resource "aws_cloudwatch_log_group" "cron_lambda" {
  name              = "/aws/lambda/balanced-cron-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

resource "aws_security_group" "cron_lambda" {
  name        = "balanced-cron-lambda-sg"
  description = "Egress for VPC-attached Lambda data reconciliation cron"
  vpc_id      = aws_vpc.main.id
  egress {
    description = "All outbound (NAT + VPC services)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "balanced-cron-lambda-sg" }
}

# =============================================================================
# LAMBDA — HEADLESS CHROMIUM RENDERER
# =============================================================================

resource "aws_lambda_function" "render_lambda" {
  function_name = "balanced-render-lambda"
  role          = aws_iam_role.render_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "render_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 2048
  timeout       = 300
  reserved_concurrent_executions = 10

  tracing_config {
    mode = "Active"
  }
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "render_lambda" {
  name              = "/aws/lambda/balanced-render-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# LAMBDA — NIGHTLY PG_DUMP SCHEDULER
# =============================================================================

resource "aws_lambda_function" "backup_lambda" {
  function_name = "balanced-backup-lambda"
  role          = aws_iam_role.backup_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "backup_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "backup_lambda" {
  name              = "/aws/lambda/balanced-backup-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# EVENTBRIDGE SCHEDULER
# =============================================================================

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "balanced-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "balanced-scheduler-invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "InvokeTargets"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = [
          aws_lambda_function.backup_lambda.arn,
          aws_lambda_function.cron_lambda.arn
        ]
      }
    ]
  })
}

resource "aws_scheduler_schedule" "scheduler_backup_lambda" {
  name       = "balanced-scheduler-backup-lambda"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression = "cron(0 2 * * ? *)"
  target {
    arn      = aws_lambda_function.backup_lambda.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

resource "aws_lambda_permission" "scheduler_backup_lambda" {
  statement_id  = "AllowSchedulerInvoke_backup_lambda"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.backup_lambda.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.scheduler_backup_lambda.arn
}

resource "aws_scheduler_schedule" "scheduler_cron_lambda" {
  name       = "balanced-scheduler-cron-lambda"
  group_name = "default"
  flexible_time_window { mode = "OFF" }
  schedule_expression = "cron(0 3 * * ? *)"
  target {
    arn      = aws_lambda_function.cron_lambda.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

resource "aws_lambda_permission" "scheduler_cron_lambda" {
  statement_id  = "AllowSchedulerInvoke_cron_lambda"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cron_lambda.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.scheduler_cron_lambda.arn
}

# =============================================================================
# SNS — OPS ALERT TOPIC
# =============================================================================

resource "aws_sns_topic" "sns_alerts" {
  name              = "balanced-sns-alerts"
  kms_master_key_id = aws_kms_key.sns.arn
}

resource "aws_sns_topic_policy" "sns_alerts" {
  arn    = aws_sns_topic.sns_alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alerts.arn
      },
      {
        Sid = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alerts.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = local.account_id
          }
        }
      },
      {
        Sid = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "sns:Publish"
        Resource = aws_sns_topic.sns_alerts.arn
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

resource "aws_sns_topic_subscription" "sns_alerts_email" {
  topic_arn = aws_sns_topic.sns_alerts.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

# =============================================================================
# CLOUDWATCH LOGS
# =============================================================================

resource "aws_cloudwatch_log_group" "cw_logs" {
  name              = "/balanced/app"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# CLOUDWATCH ALARMS
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "render_lambda_errors" {
  alarm_name          = "balanced-render-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alerts.arn]
  dimensions          = { FunctionName = aws_lambda_function.render_lambda.function_name }
}

resource "aws_cloudwatch_metric_alarm" "backup_lambda_errors" {
  alarm_name          = "balanced-backup-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alerts.arn]
  dimensions          = { FunctionName = aws_lambda_function.backup_lambda.function_name }
}

resource "aws_cloudwatch_metric_alarm" "cron_lambda_errors" {
  alarm_name          = "balanced-cron-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_actions       = [aws_sns_topic.sns_alerts.arn]
  dimensions          = { FunctionName = aws_lambda_function.cron_lambda.function_name }
}

# =============================================================================
# CLOUDFRONT
# =============================================================================

resource "aws_wafv2_web_acl" "cf" {
  provider    = aws.us_east_1
  name        = "balanced-cf-waf"
  scope       = "CLOUDFRONT"
  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "balanced-cf-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_acm_certificate" "cf" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cf_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "cf" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cf.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_cert_validation : r.fqdn]
}

data "aws_canonical_user_id" "current" {}
data "aws_cloudfront_log_delivery_canonical_user_id" "current" {}

resource "aws_s3_bucket" "cf_logs" {
  bucket_prefix = "balanced-cf-logs-"
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront delivers access logs as the awslogsdelivery CanonicalUser; grant it
# FULL_CONTROL or logging silently no-ops under Block Public Access.
resource "aws_s3_bucket_acl" "cf_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.cf_logs]
  bucket     = aws_s3_bucket.cf_logs.id
  access_control_policy {
    owner { id = data.aws_canonical_user_id.current.id }
    grant {
      grantee {
        id   = data.aws_cloudfront_log_delivery_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
    grant {
      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "s3_assets" {
  name                              = "balanced-s3-assets-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "cf" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.cf.arn
  aliases             = [var.domain_name]

  origin {
    domain_name              = aws_s3_bucket.s3_assets.bucket_regional_domain_name
    origin_id                = "s3-s3_assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_assets.id
  }
  # ALB origin over a custom domain with a TLS cert (NOT a raw AWS DNS name — rule cloudfront-origin-tls).
  origin {
    domain_name = var.origin_domain
    origin_id   = "origin-alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "origin-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    forwarded_values {
      query_string = true
      cookies { forward = "all" }
    }
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }
  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "s3-s3_assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
    min_ttl     = 86400
    default_ttl = 604800
    max_ttl     = 31536000
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    prefix          = "cf-logs/"
    include_cookies = false
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}

resource "aws_route53_record" "cf_alias" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.cf.domain_name
    zone_id                = aws_cloudfront_distribution.cf.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# CLOUDTRAIL
# =============================================================================

resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket_prefix = "balanced-cloudtrail-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "cloudtrail_logs" {
  bucket                  = aws_s3_bucket.cloudtrail_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "cloudtrail_logs" {
  bucket = aws_s3_bucket.cloudtrail_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail_logs.arn
      },
      {
        Sid = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/balanced"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs.arn
}

data "aws_iam_policy_document" "cloudtrail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cw" {
  name               = "balanced-cloudtrail-cw"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume.json
}

resource "aws_iam_role_policy" "cloudtrail_cw" {
  name = "cloudtrail-cw"
  role = aws_iam_role.cloudtrail_cw.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
      }
    ]
  })
}

resource "aws_cloudtrail" "cloudtrail" {
  name                          = "balanced-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.bucket
  is_multi_region_trail         = false
  enable_log_file_validation    = true
  include_global_service_events = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_cw.arn
  depends_on                    = [aws_s3_bucket_policy.cloudtrail_logs]
}

# =============================================================================
# X-RAY
# =============================================================================

# X-Ray needs no infrastructure resource — tracing is enabled per-function
# (tracing_config) and per-instance, and the xray:Put* IAM grants on each
# compute role (derived from the trace edges) cover it. (xray)

# =============================================================================
# APPLICATION LOAD BALANCER — HTTPS INGRESS (WEB + ADMIN)
# =============================================================================

resource "aws_security_group" "alb" {
  name        = "balanced-alb-sg"
  description = "ALB ingress for HTTPS ingress (web + admin)"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "HTTPS from CloudFront only"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    description = "To the application targets"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "balanced-alb-sg" }
}

resource "aws_lb" "alb" {
  name               = "balanced-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

resource "aws_lb_target_group" "fargate_web" {
  name        = "balanced-fargate-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "alb_https" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.fargate_web.arn
  }
}

# =============================================================================
# CLOUDWATCH DASHBOARD
# =============================================================================

resource "aws_cloudwatch_dashboard" "cw_dashboard" {
  dashboard_name = "balanced-cw-dashboard"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text"
        x = 0
        y = 0
        width = 24
        height = 2
        properties = {
          markdown = "# balanced — golden signals (golden-signal dashboard)"
        }
      }
    ]
  })
}

# =============================================================================
# ECS CLUSTER
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "balanced-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fargate_exec" {
  name               = "balanced-fargate-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "fargate_exec" {
  role       = aws_iam_role.fargate_exec.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# =============================================================================
# ELASTICACHE — ISR + SESSION CACHE
# =============================================================================

resource "aws_elasticache_subnet_group" "elasticache" {
  name       = "balanced-elasticache"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_security_group" "elasticache" {
  name        = "balanced-elasticache-sg"
  description = "ElastiCache ISR + session cache — ingress only from in-VPC callers"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "Redis from Next.js web service (2 tasks)"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.fargate_web.id]
  }
}

resource "aws_elasticache_replication_group" "elasticache" {
  replication_group_id       = "balanced-elasticache"
  description                = "ISR + session cache"
  engine                     = "redis"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  automatic_failover_enabled = false
  multi_az_enabled           = false
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.elasticache.name
  security_group_ids         = [aws_security_group.elasticache.id]
  port                       = 6379
}

# =============================================================================
# FARGATE — NEXT.JS WEB SERVICE (2 TASKS)
# =============================================================================

resource "aws_cloudwatch_log_group" "fargate_web" {
  name              = "/ecs/balanced/fargate-web"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

resource "aws_iam_role" "fargate_web" {
  name               = "balanced-fargate-web-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "fargate_web_task" {
  name   = "balanced-fargate-web-task"
  role   = aws_iam_role.fargate_web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "S3_s3_assets"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.s3_assets.arn,
          "${aws_s3_bucket.s3_assets.arn}/*"
        ]
      },
      {
        Sid = "Invoke_render_lambda"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = aws_lambda_function.render_lambda.arn
      },
      {
        Sid = "Secret_secrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.secrets.arn
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      },
      {
        Sid = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/balanced/*"
      }
    ]
  })
}

resource "aws_security_group" "fargate_web" {
  name        = "balanced-fargate-web-sg"
  description = "Fargate service Next.js web service (2 tasks)"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "From the ALB on the container port"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "All outbound (NAT + VPC services)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "balanced-fargate-web-sg" }
}

resource "aws_ecs_task_definition" "fargate_web" {
  family                   = "balanced-fargate-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.fargate_exec.arn
  task_role_arn            = aws_iam_role.fargate_web.arn
  container_definitions    = jsonencode([
    {
      name = "fargate-web"
      image = "PLACEHOLDER_ECR_IMAGE_URI"
      essential = true
      portMappings = [
        {
          containerPort = 3000
          protocol = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group" = aws_cloudwatch_log_group.fargate_web.name
          "awslogs-region" = local.region
          "awslogs-stream-prefix" = "fargate-web"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "fargate_web" {
  name            = "balanced-fargate-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.fargate_web.arn
  desired_count   = 2
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_groups  = [aws_security_group.fargate_web.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.fargate_web.arn
    container_name   = "fargate-web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.alb_https]
}

# =============================================================================
# FARGATE — ORCHESTRATOR SERVICE (1–2 TASKS)
# =============================================================================

resource "aws_cloudwatch_log_group" "fargate_orch" {
  name              = "/ecs/balanced/fargate-orch"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

resource "aws_iam_role" "fargate_orch" {
  name               = "balanced-fargate-orch-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "fargate_orch_task" {
  name   = "balanced-fargate-orch-task"
  role   = aws_iam_role.fargate_orch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "Invoke_render_lambda"
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = aws_lambda_function.render_lambda.arn
      },
      {
        Sid = "Secret_secrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.secrets.arn
      },
      {
        Sid = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      },
      {
        Sid = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/balanced/*"
      }
    ]
  })
}

resource "aws_security_group" "fargate_orch" {
  name        = "balanced-fargate-orch-sg"
  description = "Fargate service orchestrator service (1–2 tasks)"
  vpc_id      = aws_vpc.main.id
  egress {
    description = "All outbound (NAT + VPC services)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "balanced-fargate-orch-sg" }
}

resource "aws_ecs_task_definition" "fargate_orch" {
  family                   = "balanced-fargate-orch"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.fargate_exec.arn
  task_role_arn            = aws_iam_role.fargate_orch.arn
  container_definitions    = jsonencode([
    {
      name = "fargate-orch"
      image = "PLACEHOLDER_ECR_IMAGE_URI"
      essential = true
      portMappings = [
        {
          containerPort = 3000
          protocol = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group" = aws_cloudwatch_log_group.fargate_orch.name
          "awslogs-region" = local.region
          "awslogs-stream-prefix" = "fargate-orch"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "fargate_orch" {
  name            = "balanced-fargate-orch"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.fargate_orch.arn
  desired_count   = 2
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_groups  = [aws_security_group.fargate_orch.id]
    assign_public_ip = false
  }
}

# =============================================================================
# RDS — MANAGED POSTGRES + POSTGIS
# =============================================================================

resource "aws_db_subnet_group" "rds_pg" {
  name       = "balanced-rds-pg"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_security_group" "rds_pg" {
  name        = "balanced-rds-pg-sg"
  description = "RDS managed Postgres + PostGIS — ingress only from in-VPC callers"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "PostgreSQL from Next.js web service (2 tasks)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.fargate_web.id]
  }
  ingress {
    description     = "PostgreSQL from orchestrator service (1–2 tasks)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.fargate_orch.id]
  }
  ingress {
    description     = "PostgreSQL from data reconciliation cron"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.cron_lambda.id]
  }
}

resource "aws_db_instance" "rds_pg" {
  identifier                  = "balanced-rds-pg"
  engine                      = "postgres"
  instance_class              = "db.t4g.medium"
  allocated_storage           = 20
  max_allocated_storage       = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  kms_key_id                  = aws_kms_key.main.arn
  db_subnet_group_name        = aws_db_subnet_group.rds_pg.name
  vpc_security_group_ids      = [aws_security_group.rds_pg.id]
  db_name                     = "appdb"
  username                    = "appuser"
  manage_master_user_password = true
  multi_az                    = false
  backup_retention_period     = 7
  deletion_protection         = false
  skip_final_snapshot         = true
}
