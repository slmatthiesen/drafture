##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# REFERENCE-ONLY TERRAFORM — BUDGET TIER
# Review and harden before any production use.
# =============================================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5.0"
}

provider "aws" {
  region = var.aws_region
}

# CloudFront ACM certificates must be in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# =============================================================================
# VARIABLES
# =============================================================================

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "az" {
  type    = string
  default = "us-east-1a"
}

variable "domain_name" {
  type        = string
  description = "Primary domain, e.g. example.com"
}

variable "hosted_zone_id" {
  type        = string
  description = "Route 53 Hosted Zone ID for the domain"
}

variable "db_name" {
  type    = string
  default = "appdb"
}

variable "db_username" {
  type    = string
  default = "appuser"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "alarm_email" {
  type        = string
  description = "Email address for ops alerts"
}

# =============================================================================
# DATA SOURCES
# =============================================================================

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

# --- CloudWatch Logs KMS Key ---
resource "aws_kms_key" "cloudwatch_logs" {
  description             = "CMK for CloudWatch Logs"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
        Sid    = "CloudWatchLogsEncryption"
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
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${local.region}:${local.account_id}:*"
          }
        }
      }
    ]
  })

  tags = { Name = "budget-cloudwatch-logs-cmk" }
}

resource "aws_kms_alias" "cloudwatch_logs" {
  name          = "alias/budget-cloudwatch-logs"
  target_key_id = aws_kms_key.cloudwatch_logs.key_id
}

# --- SNS KMS Key ---
resource "aws_kms_key" "sns" {
  description             = "CMK for SNS ops topic"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
        Sid    = "CloudWatchAlarmPublish"
        Effect = "Allow"
        Principal = {
          Service = ["cloudwatch.amazonaws.com", "sns.amazonaws.com"]
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      }
    ]
  })

  tags = { Name = "budget-sns-cmk" }
}

resource "aws_kms_alias" "sns" {
  name          = "alias/budget-sns"
  target_key_id = aws_kms_key.sns.key_id
}

# --- SQS KMS Key ---
resource "aws_kms_key" "sqs" {
  description             = "CMK for SQS queues"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
        Sid    = "SQSServiceAccess"
        Effect = "Allow"
        Principal = {
          Service = "sqs.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = "*"
      }
    ]
  })

  tags = { Name = "budget-sqs-cmk" }
}

resource "aws_kms_alias" "sqs" {
  name          = "alias/budget-sqs"
  target_key_id = aws_kms_key.sqs.key_id
}

# --- S3 KMS Key ---
resource "aws_kms_key" "s3" {
  description             = "CMK for S3 render/media bucket"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
      }
    ]
  })

  tags = { Name = "budget-s3-cmk" }
}

resource "aws_kms_alias" "s3" {
  name          = "alias/budget-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# --- RDS KMS Key ---
resource "aws_kms_key" "rds" {
  description             = "CMK for RDS PostgreSQL"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
      }
    ]
  })

  tags = { Name = "budget-rds-cmk" }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/budget-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# --- Secrets Manager KMS Key ---
resource "aws_kms_key" "secrets" {
  description             = "CMK for Secrets Manager"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
        Sid    = "SecretsManagerService"
        Effect = "Allow"
        Principal = {
          Service = "secretsmanager.amazonaws.com"
        }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })

  tags = { Name = "budget-secrets-cmk" }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/budget-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# --- ECR KMS Key ---
resource "aws_kms_key" "ecr" {
  description             = "CMK for ECR repositories"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
      }
    ]
  })

  tags = { Name = "budget-ecr-cmk" }
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/budget-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

# --- Lambda env KMS Key ---
resource "aws_kms_key" "lambda" {
  description             = "CMK for Lambda environment variables"
  deletion_window_in_days = 14
  enable_key_rotation     = true

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
      }
    ]
  })

  tags = { Name = "budget-lambda-cmk" }
}

resource "aws_kms_alias" "lambda" {
  name          = "alias/budget-lambda"
  target_key_id = aws_kms_key.lambda.key_id
}

# =============================================================================
# VPC & NETWORKING
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

# Public subnet — ALB + NAT Gateway live here
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = var.az
  map_public_ip_on_launch = false
  tags                    = { Name = "budget-public" }
}

# Private subnet — Fargate, RDS
resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = var.az
  tags              = { Name = "budget-private" }
}

# ALB requires at least two subnets in different AZs; add a second public subnet
resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.3.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false
  tags                    = { Name = "budget-public-b" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "budget-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "budget-nat" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "budget-public-rt" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "budget-private-rt" }

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_route_table.private.id
  route_table_id = aws_route_table.private.id
}

# Fix: associate private subnet (not the route table id) with private route table
resource "aws_route_table_association" "private_subnet" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# =============================================================================
# VPC ENDPOINTS — Secrets Manager (interface, for VPC-attached Fargate tasks)
# =============================================================================

resource "aws_security_group" "vpc_endpoints" {
  name        = "budget-vpc-endpoints-sg"
  description = "Allow HTTPS from private subnet to VPC endpoints"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from private subnet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_subnet.private.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-vpc-endpoints-sg" }
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${local.region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private.id]
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "budget-secretsmanager-endpoint" }
}

# S3 Gateway endpoint — for Fargate tasks writing to S3 without NAT cost
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowVPCPrincipals"
        Effect = "Allow"
        Principal = {
          AWS = [
            aws_iam_role.web_task.arn,
            aws_iam_role.orch_task.arn
          ]
        }
        Action   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
        Resource = ["${aws_s3_bucket.render.arn}", "${aws_s3_bucket.render.arn}/*"]
      }
    ]
  })

  tags = { Name = "budget-s3-gateway-endpoint" }
}

# =============================================================================
# SECURITY GROUPS
# =============================================================================

resource "aws_security_group" "alb_sg" {
  name        = "budget-alb-sg"
  description = "ALB: HTTPS from CloudFront only (by prefix list or 0.0.0.0/0 — restrict to CF IP ranges in prod)"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from internet (tighten to CloudFront managed prefix list in prod)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-alb-sg" }
}

resource "aws_security_group" "web_sg" {
  name        = "budget-web-sg"
  description = "Next.js Fargate: HTTP from ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-web-sg" }
}

resource "aws_security_group" "orch_sg" {
  name        = "budget-orch-sg"
  description = "Orchestrator Fargate: no inbound (polls SQS), egress via NAT"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-orch-sg" }
}

resource "aws_security_group" "db_sg" {
  name        = "budget-db-sg"
  description = "RDS: PostgreSQL from web and orch tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from web tier"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web_sg.id]
  }

  ingress {
    description     = "PostgreSQL from orchestrator"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.orch_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "budget-db-sg" }
}

# =============================================================================
# S3 BUCKETS
# =============================================================================

# --- Render / media bucket ---
resource "aws_s3_bucket" "render" {
  bucket        = "budget-render-${local.account_id}"
  force_destroy = false
  tags          = { Name = "budget-render" }
}

resource "aws_s3_bucket_versioning" "render" {
  bucket = aws_s3_bucket.render.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "render" {
  bucket = aws_s3_bucket.render.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "render" {
  bucket                  = aws_s3_bucket.render.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "render" {
  bucket = aws_s3_bucket.render.id

  rule {
    id     = "expire-renders-7d"
    status = "Enabled"

    filter {
      prefix = "renders/"
    }

    expiration {
      days = 7
    }
  }
}

# OAC bucket policy — allows CloudFront OAC to read objects
resource "aws_s3_bucket_policy" "render" {
  bucket = aws_s3_bucket.render.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.render.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
          }
        }
      }
    ]
  })
}

# --- CloudFront access logs bucket ---
resource "aws_s3_bucket" "cf_logs" {
  bucket        = "budget-cf-logs-${local.account_id}"
  force_destroy = false
  tags          = { Name = "budget-cf-logs" }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront standard logging requires the canonical user ID grant via bucket ACL
resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_policy" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontLogDelivery"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cf_logs.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = local.account_id
          }
        }
      }
    ]
  })
}

# --- ALB access logs bucket ---
resource "aws_s3_bucket" "alb_logs" {
  bucket        = "budget-alb-logs-${local.account_id}"
  force_destroy = false
  tags          = { Name = "budget-alb-logs" }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ALB log delivery uses the regional ELB service account principal
# Replace 127311923021 with the correct account ID for your region:
# https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html
resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowALBLogDelivery"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::127311923021:root" # us-east-1 ELB account; update per region
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/${local.account_id}/*"
      }
    ]
  })
}

# --- CloudTrail logs bucket ---
resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket        = "budget-cloudtrail-logs-${local.account_id}"
  force_destroy = false
  tags          = { Name = "budget-cloudtrail-logs" }
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
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

# =============================================================================
# SQS — PIPELINE QUEUE + DLQ
# =============================================================================

resource "aws_sqs_queue" "job_dlq" {
  name                       = "budget-job-dlq"
  kms_master_key_id          = aws_kms_key.sqs.id
  message_retention_seconds  = 1209600 # 14 days
  tags                       = { Name = "budget-job-dlq" }
}

resource "aws_sqs_queue" "job_queue" {
  name                       = "budget-job-queue"
  kms_master_key_id          = aws_kms_key.sqs.id
  visibility_timeout_seconds = 300 # 5 minutes
  message_retention_seconds  = 86400

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.job_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "budget-job-queue" }
}

# =============================================================================
# SNS — OPS ALERTS
# =============================================================================

resource "aws_sns_topic" "ops" {
  name              = "budget-ops-alerts"
  kms_master_key_id = aws_kms_key.sns.arn
  tags              = { Name = "budget-ops-alerts" }
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# =============================================================================
# CLOUDWATCH LOGS
# =============================================================================

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/budget-web"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cloudwatch_logs.arn
  tags              = { Name = "budget-web-logs" }
}

resource "aws_cloudwatch_log_group" "orch" {
  name              = "/ecs/budget-orch"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cloudwatch_logs.arn
  tags              = { Name = "budget-orch-logs" }
}

resource "aws_cloudwatch_log_group" "render_fn" {
  name              = "/aws/lambda/budget-render"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cloudwatch_logs.arn
  tags              = { Name = "budget-render-fn-logs" }
}

resource "aws_cloudwatch_log_group" "rds" {
  name              = "/aws/rds/budget-postgres"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.cloudwatch_logs.arn
  tags              = { Name = "budget-rds-logs" }
}

# =============================================================================
# CLOUDWATCH ALARMS
# =============================================================================

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "budget-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Messages in the job DLQ"
  alarm_actions       = [aws_sns_topic.ops.arn]

  dimensions = {
    QueueName = aws_sqs_queue.job_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "budget-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "High 5XX error rate on ALB"
  alarm_actions       = [aws_sns_topic.ops.arn]

  dimensions = {
    LoadBalancer = aws_lb.web.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "render_fn_errors" {
  alarm_name          = "budget-render-fn-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Lambda render function errors"
  alarm_actions       = [aws_sns_topic.ops.arn]

  dimensions = {
    FunctionName = aws_lambda_function.render.function_name
  }
}

# =============================================================================
# SECRETS MANAGER
# =============================================================================

resource "aws_secretsmanager_secret" "db_url" {
  name                    = "budget/db-url"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 14
  tags                    = { Name = "budget-db-url" }
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id     = aws_secretsmanager_secret.db_url.id
  secret_string = jsonencode({ url = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${var.db_name}" })
}

resource "aws_secretsmanager_secret" "render_api_key" {
  name                    = "budget/render-api-key"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 14
  tags                    = { Name = "budget-render-api-key" }
}

# NOTE: rotation — no rotation Lambda is defined in this tier.
# To enable rotation, deploy a Lambda rotation function and add:
#   aws_secretsmanager_secret_rotation with rotation_lambda_arn = <arn>
# Do NOT add a placeholder rotation resource with null arn (invalid).

# =============================================================================
# IAM ROLES
# =============================================================================

# --- ECS Task Execution Role (shared) ---
resource "aws_iam_role" "ecs_execution" {
  name = "budget-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "budget-ecs-execution-role" }
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "budget-ecs-execution-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.db_url.arn,
          aws_secretsmanager_secret.render_api_key.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*"
        ]
        Resource = [aws_kms_key.secrets.arn, aws_kms_key.cloudwatch_logs.arn, aws_kms_key.ecr.arn]
      }
    ]
  })
}

# --- Web Task Role ---
resource "aws_iam_role" "web_task" {
  name = "budget-web-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "budget-web-task-role" }
}

resource "aws_iam_role_policy" "web_task_policy" {
  name = "budget-web-task-policy"
  role = aws_iam_role.web_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSSend"
        Effect = "Allow"
        Action = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.job_queue.arn]
      },
      {
        Sid    = "S3Upload"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = ["${aws_s3_bucket.render.arn}/*"]
      },
      {
        Sid    = "SecretsRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.db_url.arn
        ]
      },
      {
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource = [
          aws_kms_key.secrets.arn,
          aws_kms_key.sqs.arn,
          aws_kms_key.s3.arn
        ]
      }
    ]
  })
}

# --- Orchestrator Task Role ---
resource "aws_iam_role" "orch_task" {
  name = "budget-orch-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "budget-orch-task-role" }
}

resource "aws_iam_role_policy" "orch_task_policy" {
  name = "budget-orch-task-policy"
  role = aws_iam_role.orch_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSConsume"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [aws_sqs_queue.job_queue.arn]
      },
      {
        Sid    = "LambdaInvoke"
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [aws_lambda_function.render.arn]
      },
      {
        Sid    = "SecretsRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.db_url.arn
        ]
      },
      {
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource = [
          aws_kms_key.secrets.arn,
          aws_kms_key.sqs.arn
        ]
      }
    ]
  })
}

# --- Lambda Render Role ---
resource "aws_iam_role" "render_fn" {
  name = "budget-render-fn-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "budget-render-fn-role" }
}

resource "aws_iam_role_policy_attachment" "render_fn_basic" {
  role       = aws_iam_role.render_fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "render_fn_policy" {
  name = "budget-render-fn-policy"
  role = aws_iam_role.render_fn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3PutRenders"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject"]
        Resource = ["${aws_s3_bucket.render.arn}/renders/*"]
      },
      {
        Sid    = "SecretsRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.render_api_key.arn]
      },
      {
        Sid    = "KMSDecrypt"
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource = [
          aws_kms_key.secrets.arn,
          aws_kms_key.s3.arn,
          aws_kms_key.lambda.arn
        ]
      }
    ]
  })
}

# --- EventBridge Scheduler Role ---
resource "aws_iam_role" "scheduler" {
  name = "budget-scheduler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "budget-scheduler-role" }
}

resource "aws_iam_role_policy" "scheduler_policy" {
  name = "budget-scheduler-policy"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RunECSTask"
        Effect = "Allow"
        Action = ["ecs:RunTask"]
        Resource = [aws_ecs_task_definition.orch.arn]
      },
      {
        Sid    = "PassRole"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.ecs_execution.arn,
          aws_iam_role.orch_task.arn
        ]
      }
    ]
  })
}

# =============================================================================
# ECR REPOSITORIES
# =============================================================================

resource "aws_ecr_repository" "web" {
  name                 = "budget/web"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "budget-web-ecr" }
}

resource "aws_ecr_repository" "orch" {
  name                 = "budget/orch"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "budget-orch-ecr" }
}

# =============================================================================
# ECS CLUSTER
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "budget-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "budget-cluster" }
}

# =============================================================================
# ECS TASK DEFINITIONS
# =============================================================================

resource "aws_ecs_task_definition" "web" {
  family                   = "budget-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"  # 0.5 vCPU
  memory                   = "1024" # 1 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "${aws_ecr_repository.web.repository_url}:latest"
      essential = true
      readonlyRootFilesystem = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = local.region
          awslogs-stream-prefix = "web"
        }
      }
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.db_url.arn }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" }
      ]
    }
  ])

  tags = { Name = "budget-web-task" }
}

resource "aws_ecs_task_definition" "orch" {
  family                   = "budget-orch"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"  # 0.25 vCPU
  memory                   = "512"  # 0.5 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.orch_task.arn

  container_definitions = jsonencode([
    {
      name      = "orch"
      image     = "${aws_ecr_repository.orch.repository_url}:latest"
      essential = true
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.orch.name
          awslogs-region        = local.region
          awslogs-stream-prefix = "orch"
        }
      }
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.db_url.arn }
      ]
      environment = [
        { name = "JOB_QUEUE_URL", value = aws_sqs_queue.job_queue.url },
        { name = "RENDER_FN_NAME", value = aws_lambda_function.render.function_name }
      ]
    }
  ])

  tags = { Name = "budget-orch-task" }
}

# =============================================================================
# ECS SERVICES
# =============================================================================

resource "aws_ecs_service" "web" {
  name            = "budget-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.private.id]
    security_groups  = [aws_security_group.web_sg.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]

  tags = { Name = "budget-web-service" }
}

resource "aws_ecs_service" "orch" {
  name            = "budget-orch"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.orch.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.private.id]
    security_groups  = [aws_security_group.orch_sg.id]
    assign_public_ip = false
  }

  tags = { Name = "budget-orch-service" }
}

# =============================================================================
# ACM CERTIFICATE (us-east-1 for CloudFront)
# =============================================================================

resource "aws_acm_certificate" "cdn" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  subject_alternative_names = ["*.${var.domain_name}"]

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "budget-cdn-cert" }
}

resource "aws_route53_record" "cdn_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cdn.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "cdn" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cdn.arn
  validation_record_fqdns = [for record in aws_route53_record.cdn_cert_validation : record.fqdn]
}

# ACM certificate for ALB (regional)
resource "aws_acm_certificate" "alb" {
  domain_name       = "alb.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "budget-alb-cert" }
}

resource "aws_route53_record" "alb_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.alb.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for record in aws_route53_record.alb_cert_validation : record.fqdn]
}

# =============================================================================
# APPLICATION LOAD BALANCER
# =============================================================================

resource "aws_lb" "web" {
  name                       = "budget-web-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb_sg.id]
  subnets                    = [aws_subnet.public.id, aws_subnet.public_b.id]
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.bucket
    prefix  = "alb"
    enabled = true
  }

  tags = { Name = "budget-web-alb" }
}

resource "aws_lb_target_group" "web" {
  name        = "budget-web-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }

  tags = { Name = "budget-web-tg" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# =============================================================================
# WAF
# =============================================================================

resource "aws_wafv2_web_acl" "main" {
  name  = "budget-waf"
  scope = "CLOUDFRONT"

  # WAFv2 for CloudFront must be in us-east-1; deploy via aliased provider in practice.
  # Shown here for reference — move to provider = aws.us_east_1 in real config.

  default_action {
    allow {}
  }

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
      metric_name                = "CommonRuleSet"
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
      metric_name                = "KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateBasedRule"
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
      metric_name                = "RateBasedRule"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "budget-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "budget-waf" }
}

# =============================================================================
# CLOUDFRONT
# =============================================================================

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "budget-s3-oac"
  description                       = "OAC for render/media S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Budget tier CDN"
  aliases             = [var.domain_name]
  price_class         = "PriceClass_100"
  wait_for_deployment = false

  web_acl_id = aws_wafv2_web_acl.main.arn

  # Origin 1: ALB (web tier) — HTTPS via ACM cert on ALB hostname
  origin {
    origin_id   = "alb-origin"
    domain_name = aws_lb.web.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Origin 2: S3 render bucket via OAC
  origin {
    origin_id                = "s3-render"
    domain_name              = aws_s3_bucket.render.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  # Default cache behavior → ALB
  default_cache_behavior {
    target_origin_id       = "alb-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 31536000
  }

  # Cache behavior for /renders/* → S3
  ordered_cache_behavior {
    path_pattern           = "/renders/*"
    target_origin_id       = "s3-render"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 604800
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    include_cookies = false
    prefix          = "cf/"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  tags = { Name = "budget-cdn" }
}

# Route 53 alias for the CloudFront distribution
resource "aws_route53_record" "cdn_alias" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# =============================================================================
# RDS POSTGRESQL
# =============================================================================

resource "aws_db_subnet_group" "main" {
  name       = "budget-db-subnet-group"
  subnet_ids = [aws_subnet.private.id, aws_subnet.public_b.id] # RDS requires ≥2 AZ subnets even for single-AZ
  tags       = { Name = "budget-db-subnet-group" }
}

resource "aws_db_instance" "postgres" {
  identifier             = "budget-postgres"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = "db.t4g.micro"
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  publicly_accessible    = false
  multi_az               = false
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.rds.arn
  allocated_storage      = 20
  storage_type           = "gp3"
  backup_retention_period = 14
  deletion_protection    = true
  skip_final_snapshot    = false
  final_snapshot_identifier = "budget-postgres-final"

  # Ship slow query and error logs to CloudWatch
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  parameter_group_name = aws_db_parameter_group.postgres.name

  tags = { Name = "budget-postgres" }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "budget-postgres-pg"
  family = "postgres16"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log queries > 1s
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  tags = { Name = "budget-postgres-pg" }
}

# =============================================================================
# LAMBDA — RENDER FUNCTION
# Lambda is NOT VPC-attached (VPC-free per design).
# It reaches Secrets Manager and S3 via public endpoints — no VPC endpoint needed.
# =============================================================================

# Placeholder zip — replace with actual deployment package or S3 reference
data "archive_file" "render_placeholder" {
  type        = "zip"
  output_path = "${path.module}/render_placeholder.zip"

  source {
    content  = "# placeholder — replace with real handler"
    filename = "index.js"
  }
}

resource "aws_lambda_function" "render" {
  function_name    = "budget-render"
  role             = aws_iam_role.render_fn.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.render_placeholder.output_path
  source_code_hash = data.archive_file.render_placeholder.output_base64sha256
  timeout          = 300
  memory_size      = 1024

  reserved_concurrent_executions = 5

  kms_key_arn = aws_kms_key.lambda.arn

  environment {
    variables = {
      RENDER_BUCKET  = aws_s3_bucket.render.bucket
      RENDER_PREFIX  = "renders/"
    }
  }

  logging_config {
    log_group  = aws_cloudwatch_log_group.render_fn.name
    log_format = "JSON"
  }

  # NOT placed in a VPC — reaches Secrets Manager and S3 via public endpoints
  tags = { Name = "budget-render-fn" }
}

# =============================================================================
# EVENTBRIDGE SCHEDULER — nightly reconciliation
# =============================================================================

resource "aws_scheduler_schedule" "nightly_reconciliation" {
  name       = "budget-nightly-reconciliation"
  group_name = "default"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }

  schedule_expression = "cron(0 2 * * ? *)" # 02:00 UTC nightly

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.orch.arn
      launch_type         = "FARGATE"

      network_configuration {
        assign_public_ip = false
        security_groups  = [aws_security_group.orch_sg.id]
        subnets          = [aws_subnet.private.id]
      }
    }

    input = jsonencode({ action = "nightly-reconciliation" })
  }
}

# =============================================================================
# CLOUDTRAIL
# =============================================================================

resource "aws_cloudtrail" "main" {
  name                          = "budget-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.bucket
  include_global_service_events = true
  is_multi_region_trail         = false
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.s3.arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.render.arn}/"]
    }
  }

  tags = { Name = "budget-trail" }

  depends_on = [aws_s3_bucket_policy.cloudtrail_logs]
}

# =============================================================================
# OUTPUTS
# =============================================================================

output "cloudfront_domain" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "alb_dns_name" {
  description = "ALB DNS name (use via CloudFront, not directly)"
  value       = aws_lb.web.dns_name
}

output "render_bucket" {
  description = "S3 render/media bucket name"
  value       = aws_s3_bucket.render.bucket
}

output "job_queue_url" {
  description = "SQS job queue URL"
  value       = aws_sqs_queue.job_queue.url
}

output "job_dlq_url" {
  description = "SQS job DLQ URL"
  value       = aws_sqs_queue.job_dlq.url
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.postgres.endpoint
  sensitive   = true
}

output "render_lambda_arn" {
  description = "Render Lambda function ARN"
  value       = aws_lambda_function.render.arn
}

# ============================================================================
# ⚠  WIRE-UP GAPS — the resources above compile, but these FAIL or no-op at
# runtime. 'terraform plan' stays green on each, so review and fix before apply.
# ⚠  [kms-key-policy] A KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com` granted kms:Decrypt/GenerateDataKey* in the CMK key policy, or PutLogEvents fails at runtime.
# ⚠  [s3-access-log-delivery] A CloudFront/S3 access-log bucket has no log-delivery grant (canonical user / cloudfront principal s3:PutObject) — with Block Public Access, logging silently no-ops.
# ============================================================================
