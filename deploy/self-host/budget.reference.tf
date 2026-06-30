##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# BUDGET TIER — SELF-HOST REFERENCE
#
# One box, mirroring the real app: a t4g.small running the Fastify API + the
# built SPA, with SQLite on an encrypted EBS volume. Cloudflare is the edge
# (free TLS / CDN / WAF / DDoS) and the scale lever — when you outgrow one box,
# put an ALB + autoscaling behind the same Cloudflare hostname.
#
# Security floor (cheapest CORRECT, scales later):
#   - No SSH: SSM Session Manager only.
#   - IMDSv2 required; encrypted EBS (AWS-managed key); least-privilege IAM.
#   - Ingress locked to Cloudflare IP ranges on 80/443 — the box is never
#     reachable from the open internet.
#   - Single-region CloudTrail (free management events) + log-file validation.
#   - Secrets in SSM Parameter Store SecureString (free).
# Customer-managed CMKs, WAF web ACL, and a multi-region trail are the
# balanced+ step-ups — deliberately NOT in budget. (securityTiers.ts)
# =============================================================================

terraform {
  required_version = ">= 1.6.0"
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

# =============================================================================
# VARIABLES
# =============================================================================

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Primary AWS region."
}

variable "project" {
  type        = string
  default     = "drafture"
  description = "Name prefix for all resources."
}

variable "ops_email" {
  type        = string
  description = "Email address to receive ops alerts via SNS."
}

variable "ami_id" {
  type        = string
  description = "ARM64 AMI ID (Amazon Linux 2023 arm64) for t4g.small."
}

variable "vpc_id" {
  type        = string
  description = "Existing VPC ID to deploy into."
}

variable "public_subnet_id" {
  type        = string
  description = "Public subnet ID for the EC2 instance. The data volume is created in this subnet's AZ."
}

variable "app_domain" {
  type        = string
  description = "Hostname Cloudflare serves (e.g. app.example.com). DNS + TLS are managed in Cloudflare; point a proxied record at the instance public IP output."
}

variable "cloudflare_ipv4_cidrs" {
  type        = list(string)
  description = "Cloudflare IPv4 ranges — keep updated from https://www.cloudflare.com/ips/"
  default = [
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "108.162.192.0/18",
    "131.0.72.0/22",
    "141.101.64.0/18",
    "162.158.0.0/15",
    "172.64.0.0/13",
    "173.245.48.0/20",
    "188.114.96.0/20",
    "190.93.240.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
  ]
}

variable "cloudflare_ipv6_cidrs" {
  type        = list(string)
  description = "Cloudflare IPv6 ranges — keep updated from https://www.cloudflare.com/ips/"
  default = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
}

variable "ebs_volume_size_gb" {
  type        = number
  default     = 20
  description = "EBS gp3 data volume size in GB (SQLite store)."
}

variable "log_retention_days" {
  type        = number
  default     = 30
  description = "CloudWatch Logs retention in days."
}

variable "snapshot_retention_days" {
  type        = number
  default     = 7
  description = "Number of automated daily EBS snapshots to retain."
}

variable "backup_lifecycle_days" {
  type        = number
  default     = 30
  description = "S3 backup bucket object expiration in days."
}

# =============================================================================
# DATA SOURCES
# =============================================================================

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Pin the data volume to the SAME AZ as the instance's subnet, or the volume
# attachment fails (a volume can only attach to an instance in its own AZ).
data "aws_subnet" "app" {
  id = var.public_subnet_id
}

# The AWS-managed key that encrypts SSM SecureString parameters — the instance
# role needs kms:Decrypt on THIS key to read the API key at runtime.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# =============================================================================
# S3 — BACKUP / SNAPSHOT EXPORT BUCKET
# =============================================================================

resource "aws_s3_bucket" "backup" {
  bucket        = "${var.project}-backup-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "backup-snapshots"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    filter {}

    expiration {
      days = var.backup_lifecycle_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_lifecycle_days
    }
  }
}

# =============================================================================
# S3 — CLOUDTRAIL DELIVERY BUCKET
# =============================================================================

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "${var.project}-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    Project = var.project
    Purpose = "cloudtrail-audit"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    id     = "expire-old-trail-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail.arn
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${var.project}-trail"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "AWS:SourceArn" = "arn:aws:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${var.project}-trail"
          }
        }
      },
    ]
  })
}

# =============================================================================
# CLOUDTRAIL — single-region management events (budget floor; free)
# =============================================================================

resource "aws_cloudtrail" "main" {
  name                          = "${var.project}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = false
  enable_log_file_validation    = true

  tags = {
    Project = var.project
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

# =============================================================================
# SNS — OPS ALERTS
# =============================================================================

resource "aws_sns_topic" "ops" {
  name              = "${var.project}-ops-alerts"
  kms_master_key_id = "alias/aws/sns"

  tags = {
    Project = var.project
  }
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

resource "aws_sns_topic_policy" "ops" {
  arn = aws_sns_topic.ops.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAccountPublish"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.ops.arn
      },
      {
        Sid       = "AllowCloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.ops.arn
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })
}

# =============================================================================
# CLOUDWATCH LOGS + ALARMS
# =============================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/app/${var.project}/api"
  retention_in_days = var.log_retention_days
  # At-rest via the AWS-managed CloudWatch Logs key (budget floor; a customer
  # CMK is the balanced+ step-up).

  tags = {
    Project = var.project
  }
}

resource "aws_cloudwatch_log_metric_filter" "error_rate" {
  name           = "${var.project}-error-filter"
  pattern        = "{ $.level = \"error\" }"
  log_group_name = aws_cloudwatch_log_group.app.name

  metric_transformation {
    name          = "ErrorCount"
    namespace     = "${var.project}/App"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.project}-high-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ErrorCount"
  namespace           = "${var.project}/App"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "High application error rate detected."
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
  treat_missing_data  = "notBreaching"

  tags = {
    Project = var.project
  }
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.project}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "EC2 CPU utilization above 85%."
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.app.id
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# IAM — EC2 INSTANCE ROLE (LEAST PRIVILEGE)
# =============================================================================

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_app" {
  name               = "${var.project}-ec2-app-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = {
    Project = var.project
  }
}

# SSM Session Manager (no SSH) + CloudWatch agent.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.ec2_app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "ec2_app_inline" {
  # SSM Parameter Store — read SecureStrings under /<project>/.
  statement {
    sid     = "SSMReadSecrets"
    effect  = "Allow"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/${var.project}/*"
    ]
  }

  # Decrypt SSM SecureStrings — grant on the AWS-managed SSM key that actually
  # encrypts them (NOT a custom EBS key, or GetParameter WithDecryption fails).
  statement {
    sid       = "KMSDecryptSSM"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]
  }

  # S3 backup bucket — nightly SQLite dump upload.
  statement {
    sid     = "S3BackupWrite"
    effect  = "Allow"
    actions = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.backup.arn,
      "${aws_s3_bucket.backup.arn}/*",
    ]
  }

  # CloudWatch Logs — write app logs.
  statement {
    sid       = "CWLogsWrite"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  # CloudWatch agent reads instance metadata. DescribeTags/DescribeInstances do
  # not support resource-level scoping, so "*" is required by the API.
  statement {
    sid       = "EC2DescribeForCWAgent"
    effect    = "Allow"
    actions   = ["ec2:DescribeTags", "ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ec2_app_inline" {
  name   = "${var.project}-ec2-app-inline"
  role   = aws_iam_role.ec2_app.id
  policy = data.aws_iam_policy_document.ec2_app_inline.json
}

resource "aws_iam_instance_profile" "ec2_app" {
  name = "${var.project}-ec2-app-profile"
  role = aws_iam_role.ec2_app.name
}

# =============================================================================
# SECURITY GROUP — EC2 (Cloudflare ingress only; no SSH)
# =============================================================================

resource "aws_security_group" "ec2_app" {
  name        = "${var.project}-ec2-app-sg"
  description = "Allow HTTP/HTTPS from Cloudflare IPs only; no SSH (SSM only)"
  vpc_id      = var.vpc_id

  tags = {
    Project = var.project
    Name    = "${var.project}-ec2-app-sg"
  }
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_ipv4" {
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound IPv4 (AWS APIs, OS updates)."
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_ipv6" {
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
  description       = "Allow all outbound IPv6."
}

resource "aws_vpc_security_group_ingress_rule" "cf_http_v4" {
  for_each          = toset(var.cloudflare_ipv4_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv4 HTTP"
}

resource "aws_vpc_security_group_ingress_rule" "cf_https_v4" {
  for_each          = toset(var.cloudflare_ipv4_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv4 HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "cf_http_v6" {
  for_each          = toset(var.cloudflare_ipv6_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv6 HTTP"
}

resource "aws_vpc_security_group_ingress_rule" "cf_https_v6" {
  for_each          = toset(var.cloudflare_ipv6_cidrs)
  security_group_id = aws_security_group.ec2_app.id
  cidr_ipv6         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Cloudflare IPv6 HTTPS"
}

# =============================================================================
# EBS — gp3 DATA VOLUME (SQLite), encrypted with the AWS-managed aws/ebs key
# =============================================================================

resource "aws_ebs_volume" "db" {
  availability_zone = data.aws_subnet.app.availability_zone
  size              = var.ebs_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Project = var.project
    Name    = "${var.project}-sqlite-db"
    Backup  = "daily"
  }
}

# =============================================================================
# EC2 — t4g.small (ARM64 Fastify API + SPA host)
# =============================================================================

resource "aws_instance" "app" {
  ami                         = var.ami_id
  instance_type               = "t4g.small"
  subnet_id                   = var.public_subnet_id
  vpc_security_group_ids      = [aws_security_group.ec2_app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2_app.name
  associate_public_ip_address = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
  }

  # Format-on-first-boot (guarded) + mount the SQLite data volume, then install
  # and start the CloudWatch agent. On Nitro (t4g) AL2023 symlinks the attached
  # volume to /dev/sdf via udev. App deploy itself is out of scope for this file.
  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -euo pipefail

    DEVICE=/dev/sdf
    MOUNT=/data
    for i in $(seq 1 30); do [ -e "$DEVICE" ] && break; sleep 2; done
    if ! blkid "$DEVICE"; then
      mkfs.xfs "$DEVICE"
    fi
    mkdir -p "$MOUNT"
    grep -q "$MOUNT" /etc/fstab || echo "$DEVICE $MOUNT xfs defaults,nofail 0 2" >> /etc/fstab
    mount -a

    dnf install -y amazon-cloudwatch-agent
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CWCONFIG'
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/app/*.json",
                "log_group_name": "/app/${var.project}/api",
                "log_stream_name": "{instance_id}",
                "timezone": "UTC"
              }
            ]
          }
        }
      }
    }
    CWCONFIG

    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config -m ec2 -s \
      -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
  EOF
  )

  tags = {
    Project = var.project
    Name    = "${var.project}-api-server"
  }

  # Guard the box holding the live DB volume. REVIEW before destroying.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "db" {
  device_name  = "/dev/sdf"
  volume_id    = aws_ebs_volume.db.id
  instance_id  = aws_instance.app.id
  force_detach = false
}

# =============================================================================
# EBS SNAPSHOT LIFECYCLE (daily) — durability for the single-AZ data volume
# =============================================================================

resource "aws_iam_role" "dlm" {
  name = "${var.project}-dlm-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "ebs_daily" {
  description        = "${var.project} daily EBS snapshot"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags = {
      Backup = "daily"
    }

    schedule {
      name = "daily-0200"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["02:00"]
      }
      retain_rule {
        count = var.snapshot_retention_days
      }
      copy_tags = true
    }
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# SSM PARAMETER STORE — API KEY PLACEHOLDER
# Set the real value out-of-band:
#   aws ssm put-parameter --overwrite --type SecureString \
#     --name /<project>/anthropic_api_key --value sk-ant-...
# =============================================================================

resource "aws_ssm_parameter" "anthropic_api_key" {
  name        = "/${var.project}/anthropic_api_key"
  type        = "SecureString"
  value       = "PLACEHOLDER_REPLACE_OUT_OF_BAND"
  description = "Anthropic API key — replace via aws ssm put-parameter --overwrite."
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Project = var.project
  }
}

# =============================================================================
# OUTPUTS
# =============================================================================

output "ec2_instance_id" {
  description = "EC2 instance ID — connect with: aws ssm start-session --target <id>."
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "EC2 public IP — point a PROXIED Cloudflare DNS record at this."
  value       = aws_instance.app.public_ip
}

output "backup_bucket_name" {
  description = "S3 bucket for backups and snapshot exports."
  value       = aws_s3_bucket.backup.bucket
}

output "sns_ops_topic_arn" {
  description = "SNS topic ARN for ops alerts."
  value       = aws_sns_topic.ops.arn
}

output "ebs_volume_id" {
  description = "EBS data volume ID (SQLite store)."
  value       = aws_ebs_volume.db.id
}

output "ssm_parameter_anthropic_key_path" {
  description = "SSM Parameter Store path for the Anthropic API key."
  value       = aws_ssm_parameter.anthropic_api_key.name
}

output "app_log_group_name" {
  description = "CloudWatch Log Group for application logs."
  value       = aws_cloudwatch_log_group.app.name
}
