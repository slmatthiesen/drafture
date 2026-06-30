##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

# =============================================================================
# budget tier – Serverless no-VPC ingest
# REFERENCE ONLY – human review and hardening required before production use
# =============================================================================

terraform {
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

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "account_id" {
  type        = string
  description = "AWS account ID"
}

variable "environment" {
  type    = string
  default = "budget"
}

variable "alert_email" {
  type        = string
  description = "Operator e-mail for SNS alerts"
}

variable "cloudfront_price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "domain_name" {
  type        = string
  description = "Public domain served by CloudFront (e.g. ingest.example.com)"
}

variable "zone_id" {
  type        = string
  description = "Route 53 hosted zone ID for the domain"
}

variable "frontend_endpoint" {
  type        = string
  description = "HTTPS URL of the existing frontend to dispatch trade signals to"
}

locals {
  prefix = "${var.environment}-budget"
}

# ---------------------------------------------------------------------------
# KMS – primary customer-managed key (used by DynamoDB, SQS, S3)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "cmk_policy" {
  # Root account can manage the key via IAM
  statement {
    sid    = "RootFullAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  # DynamoDB service principal
  statement {
    sid    = "DynamoDBEncrypt"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["dynamodb.amazonaws.com"]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }

  # SQS service principal
  statement {
    sid    = "SQSEncrypt"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["sqs.amazonaws.com"]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }

  # S3 service principal (for SSE-KMS on the data-lake bucket)
  statement {
    sid    = "S3Encrypt"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }

  # Lambda execution roles (delegated via IAM – root grant above covers this,
  # but explicit grants aid readability and least-priv auditing)
  statement {
    sid    = "LambdaRolesDecrypt"
    effect = "Allow"
    principals {
      type = "AWS"
      identifiers = [
        aws_iam_role.ingest_lambda_role.arn,
        aws_iam_role.dispatch_lambda_role.arn,
        aws_iam_role.streams_lambda_role.arn,
      ]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "cmk" {
  description             = "${local.prefix} primary CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.cmk_policy.json

  tags = { Name = "${local.prefix}-cmk" }
}

resource "aws_kms_alias" "cmk" {
  name          = "alias/${local.prefix}-cmk"
  target_key_id = aws_kms_key.cmk.key_id
}

# ---------------------------------------------------------------------------
# KMS – CloudWatch Logs CMK (needs logs service principal)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "cw_logs_cmk_policy" {
  statement {
    sid    = "RootFullAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "CloudWatchLogsEncrypt"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.aws_region}:${var.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "cw_logs_cmk" {
  description             = "${local.prefix} CloudWatch Logs CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.cw_logs_cmk_policy.json

  tags = { Name = "${local.prefix}-cw-logs-cmk" }
}

resource "aws_kms_alias" "cw_logs_cmk" {
  name          = "alias/${local.prefix}-cw-logs-cmk"
  target_key_id = aws_kms_key.cw_logs_cmk.key_id
}

# ---------------------------------------------------------------------------
# KMS – SNS CMK (needs cloudwatch + sns service principals for alarm actions)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "sns_cmk_policy" {
  statement {
    sid    = "RootFullAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "SNSCloudWatchPublish"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "sns.amazonaws.com"]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "sns_cmk" {
  description             = "${local.prefix} SNS CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.sns_cmk_policy.json

  tags = { Name = "${local.prefix}-sns-cmk" }
}

resource "aws_kms_alias" "sns_cmk" {
  name          = "alias/${local.prefix}-sns-cmk"
  target_key_id = aws_kms_key.sns_cmk.key_id
}

# ---------------------------------------------------------------------------
# KMS – Secrets Manager CMK
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "secrets_cmk_policy" {
  statement {
    sid    = "RootFullAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "SecretsManagerEncrypt"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["secretsmanager.amazonaws.com"]
    }
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
  }

  statement {
    sid    = "IngestLambdaDecrypt"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.ingest_lambda_role.arn]
    }
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "secrets_cmk" {
  description             = "${local.prefix} Secrets Manager CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.secrets_cmk_policy.json

  tags = { Name = "${local.prefix}-secrets-cmk" }
}

resource "aws_kms_alias" "secrets_cmk" {
  name          = "alias/${local.prefix}-secrets-cmk"
  target_key_id = aws_kms_key.secrets_cmk.key_id
}

# ---------------------------------------------------------------------------
# Secrets Manager – webhook secret
# NOTE: Lambda is NOT VPC-attached, so it reaches the public Secrets Manager
#       endpoint directly — no interface endpoint required.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "webhook_secret" {
  name       = "${local.prefix}/webhook-token"
  kms_key_id = aws_kms_key.secrets_cmk.arn

  tags = { Name = "${local.prefix}-webhook-secret" }
}

resource "aws_secretsmanager_secret_version" "webhook_secret_placeholder" {
  secret_id     = aws_secretsmanager_secret.webhook_secret.id
  secret_string = jsonencode({ token = "REPLACE_ME_BEFORE_USE" })

  lifecycle { ignore_changes = [secret_string] }
}

# ---------------------------------------------------------------------------
# IAM roles – ingest Lambda
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingest_lambda_role" {
  name               = "${local.prefix}-ingest-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ingest_lambda_policy" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/aws/lambda/${local.prefix}-ingest:*"]
  }

  statement {
    sid    = "XRay"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  # [principal-reads-secret] – IAM grant for GetSecretValue
  statement {
    sid    = "SecretsRead"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [aws_secretsmanager_secret.webhook_secret.arn]
  }

  statement {
    sid    = "DynamoPut"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:DescribeTable",
    ]
    resources = [aws_dynamodb_table.trades.arn]
  }

  statement {
    sid    = "SQSSend"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.fanout.arn]
  }

  statement {
    sid    = "KMSUse"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = [
      aws_kms_key.cmk.arn,
      aws_kms_key.secrets_cmk.arn,
    ]
  }
}

resource "aws_iam_role_policy" "ingest_lambda" {
  name   = "${local.prefix}-ingest-lambda-policy"
  role   = aws_iam_role.ingest_lambda_role.id
  policy = data.aws_iam_policy_document.ingest_lambda_policy.json
}

# ---------------------------------------------------------------------------
# IAM roles – dispatch Lambda
# ---------------------------------------------------------------------------

resource "aws_iam_role" "dispatch_lambda_role" {
  name               = "${local.prefix}-dispatch-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "dispatch_lambda_policy" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/aws/lambda/${local.prefix}-dispatch:*"]
  }

  statement {
    sid    = "XRay"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SQSConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.fanout.arn]
  }

  statement {
    sid    = "KMSUse"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.cmk.arn]
  }
}

resource "aws_iam_role_policy" "dispatch_lambda" {
  name   = "${local.prefix}-dispatch-lambda-policy"
  role   = aws_iam_role.dispatch_lambda_role.id
  policy = data.aws_iam_policy_document.dispatch_lambda_policy.json
}

# ---------------------------------------------------------------------------
# IAM roles – streams Lambda
# ---------------------------------------------------------------------------

resource "aws_iam_role" "streams_lambda_role" {
  name               = "${local.prefix}-streams-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "streams_lambda_policy" {
  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/aws/lambda/${local.prefix}-streams:*"]
  }

  statement {
    sid    = "XRay"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DynamoStreams"
    effect = "Allow"
    actions = [
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:DescribeStream",
      "dynamodb:ListStreams",
    ]
    resources = ["${aws_dynamodb_table.trades.arn}/stream/*"]
  }

  statement {
    sid    = "S3Write"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:PutObjectAcl",
    ]
    resources = ["${aws_s3_bucket.datalake.arn}/*"]
  }

  statement {
    sid    = "KMSUse"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.cmk.arn]
  }
}

resource "aws_iam_role_policy" "streams_lambda" {
  name   = "${local.prefix}-streams-lambda-policy"
  role   = aws_iam_role.streams_lambda_role.id
  policy = data.aws_iam_policy_document.streams_lambda_policy.json
}

# ---------------------------------------------------------------------------
# CloudWatch Log Groups (KMS encrypted, 90d retention)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ingest_lambda" {
  name              = "/aws/lambda/${local.prefix}-ingest"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs_cmk.arn

  tags = { Name = "${local.prefix}-ingest-logs" }
}

resource "aws_cloudwatch_log_group" "dispatch_lambda" {
  name              = "/aws/lambda/${local.prefix}-dispatch"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs_cmk.arn

  tags = { Name = "${local.prefix}-dispatch-logs" }
}

resource "aws_cloudwatch_log_group" "streams_lambda" {
  name              = "/aws/lambda/${local.prefix}-streams"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs_cmk.arn

  tags = { Name = "${local.prefix}-streams-logs" }
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${local.prefix}"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.cw_logs_cmk.arn

  tags = { Name = "${local.prefix}-apigw-logs" }
}

# ---------------------------------------------------------------------------
# Lambda – ingest (token verify + persist)
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "ingest" {
  function_name = "${local.prefix}-ingest"
  role          = aws_iam_role.ingest_lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/placeholder/ingest.zip"

  reserved_concurrent_executions = 10

  environment {
    variables = {
      SECRET_ARN      = aws_secretsmanager_secret.webhook_secret.arn
      DYNAMO_TABLE    = aws_dynamodb_table.trades.name
      SQS_QUEUE_URL   = aws_sqs_queue.fanout.url
      POWERTOOLS_SERVICE_NAME = "${local.prefix}-ingest"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.ingest_lambda,
    aws_iam_role_policy.ingest_lambda,
  ]

  tags = { Name = "${local.prefix}-ingest" }
}

# ---------------------------------------------------------------------------
# Lambda – dispatch (SQS consumer → frontend HTTP POST)
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "dispatch" {
  function_name = "${local.prefix}-dispatch"
  role          = aws_iam_role.dispatch_lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/placeholder/dispatch.zip"

  environment {
    variables = {
      FRONTEND_ENDPOINT       = var.frontend_endpoint
      POWERTOOLS_SERVICE_NAME = "${local.prefix}-dispatch"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.dispatch_lambda,
    aws_iam_role_policy.dispatch_lambda,
  ]

  tags = { Name = "${local.prefix}-dispatch" }
}

resource "aws_lambda_event_source_mapping" "sqs_to_dispatch" {
  event_source_arn                   = aws_sqs_queue.fanout.arn
  function_name                      = aws_lambda_function.dispatch.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5

  function_response_types = ["ReportBatchItemFailures"]
}

# ---------------------------------------------------------------------------
# Lambda – streams (DynamoDB Streams → S3)
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "streams" {
  function_name = "${local.prefix}-streams"
  role          = aws_iam_role.streams_lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "${path.module}/placeholder/streams.zip"

  environment {
    variables = {
      S3_BUCKET               = aws_s3_bucket.datalake.bucket
      POWERTOOLS_SERVICE_NAME = "${local.prefix}-streams"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.streams_lambda,
    aws_iam_role_policy.streams_lambda,
  ]

  tags = { Name = "${local.prefix}-streams" }
}

resource "aws_lambda_event_source_mapping" "dynamo_streams_to_lambda" {
  event_source_arn  = aws_dynamodb_table.trades.stream_arn
  function_name     = aws_lambda_function.streams.arn
  starting_position = "LATEST"
  batch_size        = 100

  bisect_batch_on_function_error = true

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.dlq.arn
    }
  }
}

# ---------------------------------------------------------------------------
# SQS – DLQ
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.prefix}-dlq"
  kms_master_key_id          = aws_kms_key.cmk.id
  message_retention_seconds  = 1209600 # 14 days
  receive_wait_time_seconds  = 20

  tags = { Name = "${local.prefix}-dlq" }
}

# ---------------------------------------------------------------------------
# SQS – fan-out queue (with DLQ redrive)
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "fanout" {
  name                       = "${local.prefix}-fanout"
  kms_master_key_id          = aws_kms_key.cmk.id
  visibility_timeout_seconds = 30
  message_retention_seconds  = 86400
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "${local.prefix}-fanout" }
}

# Allow streams lambda destination to write failures to DLQ
resource "aws_sqs_queue_policy" "dlq_streams_policy" {
  queue_url = aws_sqs_queue.dlq.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowStreamsLambdaFailureDestination"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.dlq.arn
        Condition = {
          ArnEquals = {
            "aws:SourceArn" = aws_lambda_function.streams.arn
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# DynamoDB – trades table
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "trades" {
  name         = "${local.prefix}-trades"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tradeId"

  attribute {
    name = "tradeId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.cmk.arn
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  tags = { Name = "${local.prefix}-trades" }
}

# ---------------------------------------------------------------------------
# S3 – data lake (raw trade signal archive)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "datalake" {
  bucket        = "${local.prefix}-datalake-${var.account_id}"
  force_destroy = false

  tags = { Name = "${local.prefix}-datalake" }
}

resource "aws_s3_bucket_versioning" "datalake" {
  bucket = aws_s3_bucket.datalake.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "datalake" {
  bucket = aws_s3_bucket.datalake.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cmk.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "datalake" {
  bucket                  = aws_s3_bucket.datalake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "datalake" {
  bucket = aws_s3_bucket.datalake.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "STANDARD_IA"
    }
  }
}

# ---------------------------------------------------------------------------
# S3 – CloudFront access logs bucket
# [s3-access-log-delivery] – grant cloudfront.amazonaws.com PutObject
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "cf_logs" {
  bucket        = "${local.prefix}-cf-logs-${var.account_id}"
  force_destroy = true

  tags = { Name = "${local.prefix}-cf-logs" }
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  bucket                  = aws_s3_bucket.cf_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "cf_logs" {
  bucket = aws_s3_bucket.cf_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
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
            "aws:SourceArn" = "arn:aws:cloudfront::${var.account_id}:distribution/*"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# S3 – CloudTrail logs bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "cloudtrail_logs" {
  bucket        = "${local.prefix}-cloudtrail-${var.account_id}"
  force_destroy = false

  tags = { Name = "${local.prefix}-cloudtrail" }
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
        Resource = "${aws_s3_bucket.cloudtrail_logs.arn}/AWSLogs/${var.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# ACM Certificate (us-east-1 for CloudFront)
# [acm-certificate-validation] – paired with validation record and resource
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "cf" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.prefix}-cert" }
}

resource "aws_route53_record" "cf_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "cf" {
  certificate_arn         = aws_acm_certificate.cf.arn
  validation_record_fqdns = [for record in aws_route53_record.cf_cert_validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# API Gateway (HTTP API)
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "ingest" {
  name          = "${local.prefix}-ingest-api"
  protocol_type = "HTTP"
  description   = "Budget tier ingest endpoint"

  cors_configuration {
    allow_methods = ["POST"]
    allow_origins = ["*"] # Tighten to CloudFront domain before production
    max_age       = 300
  }

  tags = { Name = "${local.prefix}-ingest-api" }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.ingest.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 10
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
  }

  tags = { Name = "${local.prefix}-apigw-stage" }
}

resource "aws_apigatewayv2_integration" "ingest_lambda" {
  api_id             = aws_apigatewayv2_api.ingest.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.ingest.invoke_arn
  integration_method = "POST"

  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "ingest_post" {
  api_id    = aws_apigatewayv2_api.ingest.id
  route_key = "POST /ingest"
  target    = "integrations/${aws_apigatewayv2_integration.ingest_lambda.id}"
}

resource "aws_lambda_permission" "apigw_ingest" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ingest.execution_arn}/*/*/ingest"
}

# ---------------------------------------------------------------------------
# WAF WebACL (for CloudFront – must be us-east-1)
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "cf_waf" {
  name  = "${local.prefix}-cf-waf"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Managed rule: common rule set
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
      metric_name                = "${local.prefix}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  # Managed rule: known bad inputs
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
      metric_name                = "${local.prefix}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Rate-based rule
  rule {
    name     = "RateLimitRule"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 300 # per 5 minutes
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${local.prefix}-cf-waf" }
}

# ---------------------------------------------------------------------------
# CloudFront distribution
# [cloudfront-origin-tls] – origin is API Gateway (AWS-managed TLS, trusted CA)
# ---------------------------------------------------------------------------

locals {
  apigw_origin_id = "apigw-ingest"
  apigw_domain    = replace(replace(aws_apigatewayv2_api.ingest.api_endpoint, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "ingest" {
  enabled         = true
  comment         = "${local.prefix} ingest edge"
  price_class     = var.cloudfront_price_class
  aliases         = [var.domain_name]
  web_acl_id      = aws_wafv2_web_acl.cf_waf.arn
  http_version    = "http2"
  is_ipv6_enabled = true

  origin {
    domain_name = local.apigw_domain
    origin_id   = local.apigw_origin_id

    custom_origin_config {
      # API Gateway presents an ACM cert for *.execute-api.<region>.amazonaws.com –
      # trusted CA, stable hostname.
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = local.apigw_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      headers      = ["Authorization", "Content-Type"]
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.cf_logs.bucket_domain_name
    include_cookies = false
    prefix          = "cloudfront/"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = { Name = "${local.prefix}-cf" }

  depends_on = [aws_acm_certificate_validation.cf]
}

# Route 53 alias for CloudFront
resource "aws_route53_record" "cf_alias" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.ingest.domain_name
    zone_id                = aws_cloudfront_distribution.ingest.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# SNS – ops alert topic
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name              = "${local.prefix}-alerts"
  kms_master_key_id = aws_kms_key.sns_cmk.arn

  tags = { Name = "${local.prefix}-alerts" }
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudWatchPublish"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.account_id
          }
        }
      },
      {
        Sid    = "AllowAccountPublish"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.account_id}:root"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.alerts.arn
      }
    ]
  })
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------------------------------------------------------------------
# CloudWatch Metric Filters & Alarms – golden signals
# ---------------------------------------------------------------------------

# --- Error rate filter (ingest Lambda)
resource "aws_cloudwatch_metric_filter" "ingest_errors" {
  name           = "${local.prefix}-ingest-errors"
  pattern        = "{ $.level = \"ERROR\" }"
  log_group_name = aws_cloudwatch_log_group.ingest_lambda.name

  metric_transformation {
    name      = "IngestErrors"
    namespace = "${local.prefix}/Lambda"
    value     = "1"
  }
}

resource "aws_cloudwatch_alarm" "ingest_error_rate" {
  alarm_name          = "${local.prefix}-ingest-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "IngestErrors"
  namespace           = "${local.prefix}/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Ingest Lambda error rate elevated"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  tags = { Name = "${local.prefix}-ingest-error-rate" }
}

# --- Lambda throttles (ingest)
resource "aws_cloudwatch_alarm" "ingest_throttles" {
  alarm_name          = "${local.prefix}-ingest-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  dimensions = {
    FunctionName = aws_lambda_function.ingest.function_name
  }
  period             = 60
  statistic          = "Sum"
  threshold          = 0
  alarm_description  = "Ingest Lambda is being throttled"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = { Name = "${local.prefix}-ingest-throttles" }
}

# --- p99 latency (ingest Lambda)
resource "aws_cloudwatch_alarm" "ingest_p99_latency" {
  alarm_name          = "${local.prefix}-ingest-p99-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  extended_statistic  = "p99"
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  dimensions = {
    FunctionName = aws_lambda_function.ingest.function_name
  }
  period             = 60
  threshold          = 5000 # ms – tune for workload
  alarm_description  = "Ingest Lambda p99 latency > 5s"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = { Name = "${local.prefix}-ingest-p99-latency" }
}

# --- DLQ depth > 0
resource "aws_cloudwatch_alarm" "dlq_depth" {
  alarm_name          = "${local.prefix}-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
  period             = 60
  statistic          = "Sum"
  threshold          = 0
  alarm_description  = "Messages landed in DLQ – requires investigation"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  ok_actions         = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = { Name = "${local.prefix}-dlq-depth" }
}

# --- Dispatch Lambda errors
resource "aws_cloudwatch_alarm" "dispatch_errors" {
  alarm_name          = "${local.prefix}-dispatch-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  dimensions = {
    FunctionName = aws_lambda_function.dispatch.function_name
  }
  period             = 60
  statistic          = "Sum"
  threshold          = 5
  alarm_description  = "Dispatch Lambda error rate elevated"
  alarm_actions      = [aws_sns_topic.alerts.arn]
  treat_missing_data = "notBreaching"

  tags = { Name = "${local.prefix}-dispatch-errors" }
}

# ---------------------------------------------------------------------------
# CloudTrail – management + S3 data events
# ---------------------------------------------------------------------------

resource "aws_cloudtrail" "audit" {
  name                          = "${local.prefix}-audit"
  s3_bucket_name                = aws_s3_bucket.cloudtrail_logs.id
  include_global_service_events = true
  is_multi_region_trail         = false
  enable_log_file_validation    = true

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.datalake.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail_logs]

  tags = { Name = "${local.prefix}-audit" }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "cloudfront_domain" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.ingest.domain_name
}

output "api_endpoint" {
  description = "API Gateway HTTP endpoint"
  value       = aws_apigatewayv2_api.ingest.api_endpoint
}

output "dynamo_table_name" {
  description = "DynamoDB trades table name"
  value       = aws_dynamodb_table.trades.name
}

output "sqs_fanout_url" {
  description = "SQS fan-out queue URL"
  value       = aws_sqs_queue.fanout.url
}

output "sqs_dlq_url" {
  description = "SQS DLQ URL"
  value       = aws_sqs_queue.dlq.url
}

output "datalake_bucket" {
  description = "S3 data lake bucket name"
  value       = aws_s3_bucket.datalake.bucket
}

output "sns_alerts_arn" {
  description = "SNS alerts topic ARN"
  value       = aws_sns_topic.alerts.arn
}

output "webhook_secret_arn" {
  description = "Secrets Manager webhook token ARN"
  value       = aws_secretsmanager_secret.webhook_secret.arn
  sensitive   = true
}

# ============================================================================
# ⚠  WIRE-UP GAPS — the resources above compile, but these FAIL or no-op at
# runtime. 'terraform plan' stays green on each, so review and fix before apply.
# ⚠  [kms-key-policy] A KMS-encrypted CloudWatch Logs group needs `logs.<region>.amazonaws.com` granted kms:Decrypt/GenerateDataKey* in the CMK key policy, or PutLogEvents fails at runtime.
# ⚠  [s3-access-log-delivery] A CloudFront/S3 access-log bucket has no log-delivery grant (canonical user / cloudfront principal s3:PutObject) — with Block Public Access, logging silently no-ops.
# ============================================================================
