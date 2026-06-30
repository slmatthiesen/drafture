##############################################################################
# ⚠  REFERENCE ONLY — DO NOT APPLY THIS FILE BLINDLY
# AI-generated starting point, NOT production-ready and NOT reviewed.
# Applying it to an existing stack can DESTROY OR LOSE DATA, and it will need
# changes to fit your infrastructure. Even for a greenfield project: read it,
# run `terraform plan`, set a billing budget — you own every resource it creates.
##############################################################################

resource "aws_cloudfront_distribution" "budget" {
  enabled = true
  default_cache_behavior {
    target_origin_id       = "api-gateway-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "POST"]
    cached_methods         = ["GET", "HEAD"]
    min_ttl                = 0
  }

  origin {
    domain_name = aws_apigatewayv2_api.budget.api_endpoint
    origin_id   = "api-gateway-origin"
  }

  logging_config {
    include_cookies = false
    bucket         = aws_s3_bucket.cloudfront_logs.id
    prefix         = "cloudfront-logs/"
  }

  web_acl_id = aws_wafv2_web_acl.budget.arn

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

resource "aws_wafv2_web_acl" "budget" {
  name  = "budget-web-acl"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-managed-common-rule-set"
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
    name     = "rate-based"
    priority = 2
    override_action {
      none {}
    }
    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-based"
      sampled_requests_enabled   = true
    }
  }
}

resource "aws_s3_bucket" "cloudfront_logs" {
  bucket = "budget-cloudfront-logs"
}

resource "aws_s3_bucket_versioning" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_apigatewayv2_api" "budget" {
  name          = "budget-api"
  protocol_type = "HTTP"
  description   = "Webhook endpoint for budget alerts"
}

resource "aws_apigatewayv2_route" "budget" {
  api_id    = aws_apigatewayv2_api.budget.id
  route_key = "$default"
}

resource "aws_apigatewayv2_integration" "budget" {
  api_id           = aws_apigatewayv2_api.budget.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ingest.invoke_arn
  connection_type  = "INTERNET"
}

resource "aws_iam_role" "api_gateway" {
  name = "budget-api-gateway-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "apigateway.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "api_gateway" {
  name = "budget-api-gateway-policy"
  role = aws_iam_role.api_gateway.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "lambda:InvokeFunction"
        ]
        Effect = "Allow"
        Resource = aws_lambda_function.ingest.arn
      }
    ]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name    = "budget-ingest"
  handler          = "lambda_function.lambda_handler"
  runtime          = "python3.9"
  role             = aws_iam_role.ingest.arn
  timeout          = 30
  memory_size      = 128
  source_code_hash = filebase64sha256("lambda.zip")
  filename         = "lambda.zip"

  environment {
    variables = {
      TRADE_QUEUE_URL = aws_sqs_queue.trade.id,
      DLQ_URL         = aws_sqs_queue.dlq.id,
      TABLE_NAME      = aws_dynamodb_table.trades.name
    }
  }
}

resource "aws_iam_role" "ingest" {
  name = "budget-ingest-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "ingest" {
  name = "budget-ingest-policy"
  role = aws_iam_role.ingest.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Effect = "Allow"
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Action = [
          "sqs:SendMessage"
        ]
        Effect = "Allow"
        Resource = [
          aws_sqs_queue.trade.arn,
          aws_sqs_queue.dlq.arn
        ]
      },
      {
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem"
        ]
        Effect = "Allow"
        Resource = aws_dynamodb_table.trades.arn
      }
    ]
  })
}

resource "aws_sqs_queue" "trade" {
  name                      = "budget-trade-events"
  visibility_timeout_seconds = 300
  message_retention_seconds = 1209600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn,
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_policy" "trade" {
  queue_url = aws_sqs_queue.trade.id
  policy    = data.aws_iam_policy_document.sqs_trade_policy.json
}

data "aws_iam_policy_document" "sqs_trade_policy" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes"
    ]
    resources = [aws_sqs_queue.trade.arn]
  }
}

resource "aws_sqs_queue" "dlq" {
  name              = "budget-ingest-dlq"
  message_retention_seconds = 1209600
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "budget-dlq-depth-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = "60"
  statistic           = "Sum"
  threshold           = "0"
  alarm_description   = "Alarm when DLQ has messages"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
}

resource "aws_lambda_function" "eval" {
  function_name    = "budget-eval"
  handler          = "lambda_function.lambda_handler"
  runtime          = "python3.9"
  role             = aws_iam_role.eval.arn
  timeout          = 300
  memory_size      = 512
  source_code_hash = filebase64sha256("eval_lambda.zip")
  filename         = "eval_lambda.zip"

  environment {
    variables = {
      TRADE_QUEUE_URL = aws_sqs_queue.trade.id,
      TABLE_NAME      = aws_dynamodb_table.trades.name,
      S3_BUCKET       = aws_s3_bucket.results.id,
      SECRET_NAME     = aws_secretsmanager_secret.market_data.name
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.eval_dlq.arn
  }
}

resource "aws_iam_role" "eval" {
  name = "budget-eval-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "eval" {
  name = "budget-eval-policy"
  role = aws_iam_role.eval.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Effect = "Allow"
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Action = [
          "sqs:DeleteMessage"
        ]
        Effect = "Allow"
        Resource = aws_sqs_queue.trade.arn
      },
      {
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem"
        ]
        Effect = "Allow"
        Resource = aws_dynamodb_table.trades.arn
      },
      {
        Action = [
          "s3:PutObject"
        ]
        Effect = "Allow"
        Resource = "${aws_s3_bucket.results.arn}/*"
      },
      {
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Effect = "Allow"
        Resource = aws_secretsmanager_secret.market_data.arn
      }
    ]
  })
}

resource "aws_sqs_queue" "eval_dlq" {
  name              = "budget-eval-dlq"
  message_retention_seconds = 1209600
}

resource "aws_dynamodb_table" "trades" {
  name         = "budget-trades"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_s3_bucket" "results" {
  bucket = "budget-eval-results"
}

resource "aws_s3_bucket_versioning" "results" {
  bucket = aws_s3_bucket.results.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "results" {
  bucket = aws_s3_bucket.results.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "results" {
  bucket = aws_s3_bucket.results.id

  rule {
    id     = "expire-after-90-days"
    status = "Enabled"

    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_public_access_block" "results" {
  bucket = aws_s3_bucket.results.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_secretsmanager_secret" "market_data" {
  name                    = "budget/market-data-api-key"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_rotation" "market_data" {
  secret_id = aws_secretsmanager_secret.market_data.id
  rotation_lambda_arn    = aws_lambda_function.rotate_secret.arn
  rotation_rules {
    automatically_after_days = 30
  }
}

resource "aws_lambda_function" "rotate_secret" {
  function_name    = "budget-rotate-secret"
  handler          = "lambda_function.lambda_handler"
  runtime          = "python3.9"
  role             = aws_iam_role.rotate_secret.arn
  source_code_hash = filebase64sha256("rotate_secret.zip")
  filename         = "rotate_secret.zip"
}

resource "aws_iam_role" "rotate_secret" {
  name = "budget-rotate-secret-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "rotate_secret" {
  name = "budget-rotate-secret-policy"
  role = aws_iam_role.rotate_secret.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:RotateSecret"
        ]
        Effect = "Allow"
        Resource = aws_secretsmanager_secret.market_data.arn
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "budget" {
  name              = "/aws/lambda/budget"
  retention_in_days = 30

  kms_key_id = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "eval" {
  name              = "/aws/lambda/budget-eval"
  retention_in_days = 30

  kms_key_id = aws_kms_key.logs.arn
}

resource "aws_kms_key" "logs" {
  description = "KMS key for CloudWatch Logs encryption"
  enable_key_rotation = true
}

resource "aws_kms_alias" "logs" {
  name          = "alias/budget-logs"
  target_key_id = aws_kms_key.logs.id
}

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "budget-error-rate-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = "60"
  statistic           = "Sum"
  threshold           = "1"
  alarm_description   = "Alarm when Lambda function errors"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.ingest.function_name
  }
}

resource "aws_sns_topic" "alerts" {
  name = "budget-alerts"
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.sns_alerts_policy.json
}

data "aws_iam_policy_document" "sns_alerts_policy" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    actions = [
      "SNS:Publish"
    ]
    resources = [aws_sns_topic.alerts.arn]
  }
}

resource "aws_cloudtrail" "budget" {
  name                          = "budget-cloudtrail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_file_validation        = true
  kms_key_id                    = aws_kms_key.cloudtrail.arn
}

resource "aws_s3_bucket" "cloudtrail" {
  bucket = "budget-cloudtrail"
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_kms_key" "cloudtrail" {
  description = "KMS key for CloudTrail encryption"
  enable_key_rotation = true
}

resource "aws_kms_alias" "cloudtrail" {
  name          = "alias/budget-cloudtrail"
  target_key_id = aws_kms_key.cloudtrail.id
}

resource "aws_lambda_event_source_mapping" "trade_queue" {
  event_source_arn = aws_sqs_queue.trade.arn
  function_name    = aws_lambda_function.eval.arn
  batch_size       = 1
}