##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# REFERENCE-ONLY Terraform for the BUDGET tier — generated
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

variable "ami_id" {
  type        = string
  description = "Machine image for the application box (Amazon Linux 2023 recommended)."
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
  description             = "budget main CMK — S3, EBS, Secrets Manager"
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
  name          = "alias/budget-main"
  target_key_id = aws_kms_key.main.key_id
}

# CloudWatch Logs CMK — the Logs service principal MUST be granted, keyed off
# the LITERAL region (not ${local.region}), or PutLogEvents fails at runtime.
resource "aws_kms_key" "cw_logs" {
  description             = "budget CloudWatch Logs CMK"
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
  name          = "alias/budget-cw-logs"
  target_key_id = aws_kms_key.cw_logs.key_id
}

# SNS CMK — a CloudWatch alarm publishing to an encrypted topic needs BOTH the
# cloudwatch and sns service principals, or alarm publish fails at runtime.
resource "aws_kms_key" "sns" {
  description             = "budget SNS ops-alert CMK"
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
  name          = "alias/budget-sns"
  target_key_id = aws_kms_key.sns.key_id
}

# =============================================================================
# NETWORKING
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "budget-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "budget-igw" }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "budget-public-a" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "budget-public-rt" }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# =============================================================================
# IAM
# =============================================================================

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

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
  name               = "budget-cron-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "cron_lambda_managed" {
  role       = aws_iam_role.cron_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cron_lambda_inline" {
  name = "budget-cron-lambda-inline"
  role = aws_iam_role.cron_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "SSMPortForward"
        Effect = "Allow"
        Action = [
          "ssm:StartSession",
          "ssm:TerminateSession",
          "ssm:DescribeSessions"
        ]
        Resource = [
          aws_instance.ec2_box.arn,
          "arn:${local.partition}:ssm:${local.region}:${local.account_id}:document/AWS-StartPortForwardingSession"
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
# IAM — HEADLESS CHROMIUM RENDERER
# =============================================================================

resource "aws_iam_role" "render_lambda" {
  name               = "budget-render-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "render_lambda_managed" {
  role       = aws_iam_role.render_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "render_lambda_inline" {
  name = "budget-render-lambda-inline"
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
  name               = "budget-backup-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "backup_lambda_managed" {
  role       = aws_iam_role.backup_lambda.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "backup_lambda_inline" {
  name = "budget-backup-lambda-inline"
  role = aws_iam_role.backup_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid = "SSMPortForward"
        Effect = "Allow"
        Action = [
          "ssm:StartSession",
          "ssm:TerminateSession",
          "ssm:DescribeSessions"
        ]
        Resource = [
          aws_instance.ec2_box.arn,
          "arn:${local.partition}:ssm:${local.region}:${local.account_id}:document/AWS-StartPortForwardingSession"
        ]
      },
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
# IAM — WEB + ORCHESTRATOR HOST
# =============================================================================

resource "aws_iam_role" "ec2_box" {
  name               = "budget-ec2-box-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ec2_box_managed" {
  role       = aws_iam_role.ec2_box.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "ec2_box_inline" {
  name = "budget-ec2-box-inline"
  role = aws_iam_role.ec2_box.id
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
        Resource = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/budget/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2_box" {
  name = "budget-ec2-box-profile"
  role = aws_iam_role.ec2_box.name
}

# =============================================================================
# SECURITY GROUP — WEB + ORCHESTRATOR HOST
# =============================================================================

resource "aws_security_group" "ec2_box" {
  name        = "budget-ec2-box-sg"
  description = "Ingress for web + orchestrator host; egress to AWS services"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTPS from CloudFront only"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  ingress {
    description     = "HTTP from CloudFront only (redirect)"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-ec2-box-sg" }
}

# =============================================================================
# EC2 — WEB + ORCHESTRATOR HOST
# =============================================================================

resource "aws_instance" "ec2_box" {
  ami                    = var.ami_id
  instance_type          = "t4g.medium"
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.ec2_box.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_box.name

  # IMDSv2 required (no v1 fallback).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
    kms_key_id  = aws_kms_key.main.arn
  }

  tags = { Name = "budget-ec2-box" }
}

# =============================================================================
# SELF-MANAGED POSTGRESQL — PRIMARY DB (LOCALHOST)
# =============================================================================

# Self-managed Postgres rides on the EC2 box (localhost-bound, not network-
# exposed). Its data lives on a dedicated KMS-encrypted gp3 EBS volume.
resource "aws_ebs_volume" "postgres" {
  availability_zone = "us-east-1a"
  size              = 50
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.main.arn
  tags              = { Name = "budget-postgres" }
}

resource "aws_volume_attachment" "postgres" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.postgres.id
  instance_id = aws_instance.ec2_box.id
}

# =============================================================================
# S3 — DB BACKUP STORE
# =============================================================================

resource "aws_s3_bucket" "s3_backups" {
  bucket_prefix = "budget-s3-backups-"
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
  bucket_prefix = "budget-s3-assets-"
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
  bucket_prefix = "budget-s3-renders-"
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
  name       = "budget/secrets"
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
  function_name = "budget-cron-lambda"
  role          = aws_iam_role.cron_lambda.arn
  # Placeholder package — replace with your real deployment artifact.
  filename      = "cron_lambda_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 300
  # No vpc_config — a non-VPC Lambda reaches public AWS endpoints directly
  # (Secrets Manager, S3) with no NAT, the cost-honest default.
}

resource "aws_cloudwatch_log_group" "cron_lambda" {
  name              = "/aws/lambda/budget-cron-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# LAMBDA — HEADLESS CHROMIUM RENDERER
# =============================================================================

resource "aws_lambda_function" "render_lambda" {
  function_name = "budget-render-lambda"
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
  name              = "/aws/lambda/budget-render-lambda"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# LAMBDA — NIGHTLY PG_DUMP SCHEDULER
# =============================================================================

resource "aws_lambda_function" "backup_lambda" {
  function_name = "budget-backup-lambda"
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
  name              = "/aws/lambda/budget-backup-lambda"
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
  name               = "budget-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "budget-scheduler-invoke"
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
  name       = "budget-scheduler-backup-lambda"
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
  name       = "budget-scheduler-cron-lambda"
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
  name              = "budget-sns-alerts"
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
  name              = "/budget/app"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# CLOUDWATCH ALARMS
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "ec2_box_cpu_high" {
  alarm_name          = "budget-ec2-box-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.sns_alerts.arn]
  ok_actions          = [aws_sns_topic.sns_alerts.arn]
  dimensions          = { InstanceId = aws_instance.ec2_box.id }
}

resource "aws_cloudwatch_metric_alarm" "render_lambda_errors" {
  alarm_name          = "budget-render-lambda-errors"
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
  alarm_name          = "budget-backup-lambda-errors"
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
  alarm_name          = "budget-cron-lambda-errors"
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
  name        = "budget-cf-waf"
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
    metric_name                = "budget-cf-waf"
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
  bucket_prefix = "budget-cf-logs-"
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
  name                              = "budget-s3-assets-oac"
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
  # EC2 origin over a custom domain with a TLS cert (NOT a raw AWS DNS name — rule cloudfront-origin-tls).
  origin {
    domain_name = var.origin_domain
    origin_id   = "origin-ec2_box"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "origin-ec2_box"
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
  bucket_prefix = "budget-cloudtrail-"
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
  name              = "/aws/cloudtrail/budget"
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
  name               = "budget-cloudtrail-cw"
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
  name                          = "budget-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.bucket
  is_multi_region_trail         = true
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
