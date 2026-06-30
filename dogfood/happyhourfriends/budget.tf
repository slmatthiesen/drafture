##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# REFERENCE-ONLY — NOT PRODUCTION-READY. Human review and hardening required.
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

# ACM for CloudFront MUST be in us-east-1
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
  description = "Primary domain, e.g. example.com"
}

variable "ec2_origin_domain" {
  type        = string
  description = "Custom domain (ALB or Elastic IP + Route53) for the EC2 origin — must have ACM cert"
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for domain_name"
}

variable "ami_id" {
  type        = string
  description = "ARM64 AMI for t4g.medium (Amazon Linux 2023 recommended)"
}

variable "ops_email" {
  type        = string
  description = "Email address for SNS ops alerts"
}

variable "cloudtrail_log_group_name" {
  type    = string
  default = "/aws/cloudtrail/audit"
}

variable "allowed_cloudfront_prefix_list_id" {
  type        = string
  description = "AWS-managed prefix list for CloudFront IPs (pl-xxxxxxxx)"
  default     = "pl-3b927c52" # us-east-1 example — verify for your region
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

# --- General-purpose KMS key (S3 assets, S3 renders, S3 backups, EBS, Secrets) ---
resource "aws_kms_key" "main" {
  description             = "Main KMS key — S3, EBS, Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowSecretsManager"
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

# --- CloudWatch Logs KMS key (needs logs service principal) ---
resource "aws_kms_key" "cw_logs" {
  description             = "KMS key for CloudWatch Logs encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${local.region}.amazonaws.com"
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
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${local.region}:${local.account_id}:*"
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

# --- SNS KMS key (CloudWatch Alarms → SNS requires cloudwatch.amazonaws.com grant) ---
resource "aws_kms_key" "sns" {
  description             = "KMS key for SNS ops alert topic"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RootAccountFullAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowCloudWatchAlarms"
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
        Sid    = "AllowSNSService"
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
# NETWORKING (minimal — single public subnet for t4g.medium)
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "budget-vpc" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${local.region}a"
  map_public_ip_on_launch = true

  tags = { Name = "budget-public" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "budget-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "budget-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# =============================================================================
# SECURITY GROUP — EC2
# Only accepts 443/80 from CloudFront managed prefix list
# =============================================================================

resource "aws_security_group" "ec2" {
  name        = "budget-ec2-sg"
  description = "Allow HTTPS/HTTP only from CloudFront; egress to AWS services"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTPS from CloudFront"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [var.allowed_cloudfront_prefix_list_id]
  }

  ingress {
    description     = "HTTP from CloudFront (redirect)"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [var.allowed_cloudfront_prefix_list_id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-ec2-sg" }
}

# =============================================================================
# IAM — EC2 INSTANCE ROLE
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

resource "aws_iam_role" "ec2" {
  name               = "budget-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "ec2_inline" {
  name = "budget-ec2-inline"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3AssetsReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.assets.arn,
          "${aws_s3_bucket.assets.arn}/*"
        ]
      },
      {
        Sid    = "SecretsManagerRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.db_creds.arn
        ]
      },
      {
        Sid    = "LambdaInvokeRender"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.render.arn
        ]
      },
      {
        Sid    = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [
          aws_kms_key.main.arn
        ]
      },
      {
        Sid    = "XRayWrite"
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
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "budget-ec2-profile"
  role = aws_iam_role.ec2.name
}

# =============================================================================
# EC2 INSTANCE
# =============================================================================

resource "aws_ebs_volume" "postgres_data" {
  availability_zone = "${local.region}a"
  size              = 50
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.main.arn

  tags = { Name = "budget-postgres-data" }
}

resource "aws_instance" "app" {
  ami                     = var.ami_id
  instance_type           = "t4g.medium"
  subnet_id               = aws_subnet.public.id
  vpc_security_group_ids  = [aws_security_group.ec2.id]
  iam_instance_profile    = aws_iam_instance_profile.ec2.name

  # IMDSv2 enforced
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

  tags = { Name = "budget-app" }
}

resource "aws_volume_attachment" "postgres_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.postgres_data.id
  instance_id = aws_instance.app.id
}

# =============================================================================
# S3 — ASSETS BUCKET (ISR + media)
# =============================================================================

resource "aws_s3_bucket" "assets" {
  bucket_prefix = "budget-assets-"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action   = "s3:*"
        Resource = [
          aws_s3_bucket.assets.arn,
          "${aws_s3_bucket.assets.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — RENDER OUTPUT BUCKET
# =============================================================================

resource "aws_s3_bucket" "renders" {
  bucket_prefix = "budget-renders-"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "renders" {
  bucket = aws_s3_bucket.renders.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "renders" {
  bucket                  = aws_s3_bucket.renders.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "renders" {
  bucket = aws_s3_bucket.renders.id
  rule {
    id     = "expire-7-days"
    status = "Enabled"
    expiration { days = 7 }
  }
}

resource "aws_s3_bucket_policy" "renders" {
  bucket = aws_s3_bucket.renders.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action   = "s3:*"
        Resource = [
          aws_s3_bucket.renders.arn,
          "${aws_s3_bucket.renders.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — DB BACKUP BUCKET
# =============================================================================

resource "aws_s3_bucket" "backups" {
  bucket_prefix = "budget-backups-"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "glacier-then-expire"
    status = "Enabled"
    transition {
      days          = 1
      storage_class = "GLACIER_IR"
    }
    expiration { days = 14 }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action   = "s3:*"
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — CLOUDFRONT ACCESS LOGS BUCKET
# (Must grant cloudfront.amazonaws.com s3:PutObject)
# =============================================================================

resource "aws_s3_bucket" "cf_logs" {
  bucket_prefix = "budget-cf-logs-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCFLogDelivery"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cf_logs.arn}/cf-logs/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}

# =============================================================================
# S3 — CLOUDTRAIL LOGS BUCKET
# =============================================================================

resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket_prefix = "budget-cloudtrail-logs-"
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
        Sid    = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail_logs.arn
      },
      {
        Sid    = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" }
        }
      }
    ]
  })
}

# =============================================================================
# SECRETS MANAGER
# (No rotation Lambda provided — rotation block omitted per rule #5)
# =============================================================================

resource "aws_secretsmanager_secret" "db_creds" {
  name       = "budget/db-creds"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "db_creds" {
  secret_id     = aws_secretsmanager_secret.db_creds.id
  secret_string = jsonencode({
    username = "postgres"
    password = "REPLACE_ME"  # Replace via console or external secret injection
    host     = "localhost"
    port     = 5432
    dbname   = "appdb"
  })
}

# =============================================================================
# IAM — RENDER LAMBDA ROLE
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

resource "aws_iam_role" "render_lambda" {
  name               = "budget-render-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "render_lambda_basic" {
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
        Sid    = "S3RendersWrite"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject"
        ]
        Resource = "${aws_s3_bucket.renders.arn}/*"
      },
      {
        Sid    = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      },
      {
        Sid    = "XRayWrite"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets"
        ]
        Resource = "*"
      }
    ]
  })
}

# =============================================================================
# LAMBDA — RENDER (arm64, 2048 MB, no VPC)
# =============================================================================

resource "aws_lambda_function" "render" {
  function_name = "budget-render"
  role          = aws_iam_role.render_lambda.arn
  # Placeholder — replace with actual deployment package
  filename      = "render_placeholder.zip"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  memory_size   = 2048
  timeout       = 300

  reserved_concurrent_executions = 10

  tracing_config { mode = "Active" }

  environment {
    variables = {
      RENDERS_BUCKET = aws_s3_bucket.renders.bucket
    }
  }

  # No vpc_config — non-VPC Lambda reaches public AWS endpoints directly
}

resource "aws_cloudwatch_log_group" "render_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.render.function_name}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# IAM — BACKUP LAMBDA ROLE
# =============================================================================

resource "aws_iam_role" "backup_lambda" {
  name               = "budget-backup-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "backup_lambda_basic" {
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
        Sid    = "S3BackupsWrite"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/*"
        ]
      },
      {
        Sid    = "SecretsManagerRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.db_creds.arn]
      },
      {
        Sid    = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      },
      {
        # SSM to open port-forward tunnel to EC2
        Sid    = "SSMStartSession"
        Effect = "Allow"
        Action = [
          "ssm:StartSession",
          "ssm:TerminateSession",
          "ssm:DescribeSessions"
        ]
        Resource = [
          aws_instance.app.arn,
          "arn:${local.partition}:ssm:${local.region}:${local.account_id}:document/AWS-StartPortForwardingSession"
        ]
      }
    ]
  })
}

# =============================================================================
# LAMBDA — BACKUP (arm64, no VPC — reaches SSM + S3 public endpoints)
# =============================================================================

resource "aws_lambda_function" "backup" {
  function_name = "budget-backup"
  role          = aws_iam_role.backup_lambda.arn
  filename      = "backup_placeholder.zip"
  handler       = "index.handler"
  runtime       = "python3.12"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 900

  environment {
    variables = {
      BACKUP_BUCKET  = aws_s3_bucket.backups.bucket
      SECRET_ARN     = aws_secretsmanager_secret.db_creds.arn
      EC2_INSTANCE_ID = aws_instance.app.id
    }
  }
}

resource "aws_cloudwatch_log_group" "backup_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.backup.function_name}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# IAM — CRON LAMBDA ROLE
# =============================================================================

resource "aws_iam_role" "cron_lambda" {
  name               = "budget-cron-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "cron_lambda_basic" {
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
        Sid    = "SecretsManagerRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.db_creds.arn]
      },
      {
        Sid    = "KMSDecryptMain"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = aws_kms_key.main.arn
      },
      {
        Sid    = "SSMStartSession"
        Effect = "Allow"
        Action = [
          "ssm:StartSession",
          "ssm:TerminateSession",
          "ssm:DescribeSessions"
        ]
        Resource = [
          aws_instance.app.arn,
          "arn:${local.partition}:ssm:${local.region}:${local.account_id}:document/AWS-StartPortForwardingSession"
        ]
      }
    ]
  })
}

# =============================================================================
# LAMBDA — CRON / DATA RECONCILIATION (arm64, no VPC)
# =============================================================================

resource "aws_lambda_function" "cron" {
  function_name = "budget-cron"
  role          = aws_iam_role.cron_lambda.arn
  filename      = "cron_placeholder.zip"
  handler       = "index.handler"
  runtime       = "python3.12"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 300

  environment {
    variables = {
      SECRET_ARN      = aws_secretsmanager_secret.db_creds.arn
      EC2_INSTANCE_ID = aws_instance.app.id
    }
  }
}

resource "aws_cloudwatch_log_group" "cron_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.cron.function_name}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# EVENTBRIDGE SCHEDULER — BACKUP + CRON
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
  name               = "budget-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler_inline" {
  name = "budget-scheduler-invoke"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeLambdas"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.backup.arn,
          aws_lambda_function.cron.arn
        ]
      }
    ]
  })
}

resource "aws_scheduler_schedule" "nightly_backup" {
  name       = "budget-nightly-backup"
  group_name = "default"

  flexible_time_window { mode = "OFF" }

  schedule_expression = "cron(0 2 * * ? *)"

  target {
    arn      = aws_lambda_function.backup.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

resource "aws_scheduler_schedule" "reconciliation" {
  name       = "budget-reconciliation"
  group_name = "default"

  flexible_time_window { mode = "OFF" }

  schedule_expression = "cron(0 6 * * ? *)"

  target {
    arn      = aws_lambda_function.cron.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}

# Lambda permission for EventBridge Scheduler to invoke
resource "aws_lambda_permission" "scheduler_invoke_backup" {
  statement_id  = "AllowSchedulerInvokeBackup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.backup.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.nightly_backup.arn
}

resource "aws_lambda_permission" "scheduler_invoke_cron" {
  statement_id  = "AllowSchedulerInvokeCron"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cron.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.reconciliation.arn
}

# =============================================================================
# SNS — OPS ALERT TOPIC
# =============================================================================

resource "aws_sns_topic" "ops_alerts" {
  name              = "budget-ops-alerts"
  kms_master_key_id = aws_kms_key.sns.arn
}

resource "aws_sns_topic_policy" "ops_alerts" {
  arn = aws_sns_topic.ops_alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:${local.partition}:iam::${local.account_id}:root"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.ops_alerts.arn
      },
      {
        Sid    = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.ops_alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
        }
      },
      {
        Sid    = "DenyNonTLS"
        Effect = "Deny"
        Principal = "*"
        Action   = "sns:Publish"
        Resource = aws_sns_topic.ops_alerts.arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

# =============================================================================
# CLOUDWATCH LOGS — APP LOG GROUP
# =============================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/budget/app"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cw_logs.arn
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = var.cloudtrail_log_group_name
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs.arn
}

# =============================================================================
# CLOUDWATCH ALARMS (golden signals)
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "ec2_cpu_high" {
  alarm_name          = "budget-ec2-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "EC2 CPU > 80% for 3 minutes"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    InstanceId = aws_instance.app.id
  }
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
  alarm_description   = "Render Lambda errors > 5 in 5 min"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.render.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_lambda_errors" {
  alarm_name          = "budget-backup-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Backup Lambda failed"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.backup.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "cf_5xx" {
  alarm_name          = "budget-cf-5xx-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 5
  alarm_description   = "CloudFront 5xx error rate > 5%"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }
}

# =============================================================================
# WAF (for CloudFront — must be us-east-1)
# =============================================================================

resource "aws_wafv2_web_acl" "main" {
  provider    = aws.us_east_1
  name        = "budget-cf-waf"
  scope       = "CLOUDFRONT"
  description = "WAF for CloudFront distribution"

  default_action { allow {} }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action { none {} }

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

    override_action { none {} }

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

    action { block {} }

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

# =============================================================================
# ACM CERTIFICATE (us-east-1 for CloudFront)
# =============================================================================

resource "aws_acm_certificate" "main" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  subject_alternative_names = [
    "www.${var.domain_name}"
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options :
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

resource "aws_acm_certificate_validation" "main" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# =============================================================================
# CLOUDFRONT — OAC FOR S3 ASSETS
# =============================================================================

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "budget-assets-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# =============================================================================
# CLOUDFRONT DISTRIBUTION
# EC2 origin uses ec2_origin_domain (custom domain with ACM cert — rule #2)
# =============================================================================

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.main.arn
  aliases             = [var.domain_name, "www.${var.domain_name}"]

  # Origin 1 — S3 assets (OAC)
  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  # Origin 2 — EC2 (custom domain + ACM cert, NOT public_dns per rule #2)
  origin {
    domain_name = var.ec2_origin_domain
    origin_id   = "ec2-app"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default cache behaviour → EC2
  default_cache_behavior {
    target_origin_id       = "ec2-app"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      cookies      { forward = "all" }
      headers      = ["Authorization", "CloudFront-Forwarded-Proto", "Host"]
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # Ordered cache behaviour → S3 static assets
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies      { forward = "none" }
    }

    min_ttl     = 86400
    default_ttl = 604800
    max_ttl     = 31536000
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.main.certificate_arn
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

# Route53 A record → CloudFront
resource "aws_route53_record" "apex" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www" {
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# CLOUDTRAIL
# =============================================================================

data "aws_iam_policy_document" "cloudtrail_cw_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cw" {
  name               = "budget-cloudtrail-cw-role"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_cw_logs_assume.json
}

resource "aws_iam_role_policy" "cloudtrail_cw_inline" {
  name = "cloudtrail-cw-inline"
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

resource "aws_cloudtrail" "main" {
  name                          = "budget-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.bucket
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  include_global_service_events = true

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_cw.arn

  depends_on = [aws_s3_bucket_policy.cloudtrail_logs]
}

# =============================================================================
# X-RAY — no infrastructure resource needed; IAM grants on roles cover it
# =============================================================================

# =============================================================================
# OUTPUTS
# =============================================================================

output "cloudfront_domain" {
  value       = aws_cloudfront_distribution.main.domain_name
  description = "CloudFront distribution domain"
}

output "assets_bucket" {
  value       = aws_s3_bucket.assets.bucket
  description = "ISR assets S3 bucket name"
}

output "renders_bucket" {
  value       = aws_s3_bucket.renders.bucket
  description = "Render output S3 bucket name"
}

output "backups_bucket" {
  value       = aws_s3_bucket.backups.bucket
  description = "DB backup S3 bucket name"
}

output "render_lambda_arn" {
  value       = aws_lambda_function.render.arn
  description = "Render Lambda ARN"
}

output "ec2_instance_id" {
  value       = aws_instance.app.id
  description = "EC2 app instance ID"
}

output "db_secret_arn" {
  value       = aws_secretsmanager_secret.db_creds.arn
  description = "Secrets Manager secret ARN for DB credentials"
}

output "sns_ops_topic_arn" {
  value       = aws_sns_topic.ops_alerts.arn
  description = "SNS ops alerts topic ARN"
}

# ============================================================================
# ⚠  WIRE-UP GAPS — the resources above compile, but these FAIL or no-op at
# runtime. 'terraform plan' stays green on each, so review and fix before apply.
# ⚠  [kms-key-policy] A KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com` granted kms:Decrypt/GenerateDataKey* in the CMK key policy, or PutLogEvents fails at runtime.
# ⚠  [cloudfront-origin-tls] A CloudFront https-only origin targets an EC2 public_dns — no trusted CA cert exists for *.compute-1.amazonaws.com and the DNS churns on replacement. Use an ALB+ACM origin, EIP+domain+cert, or API Gateway/Lambda.
# ⚠  [s3-access-log-delivery] A CloudFront/S3 access-log bucket has no log-delivery grant (canonical user / cloudfront principal s3:PutObject) — with Block Public Access, logging silently no-ops.
# ============================================================================
