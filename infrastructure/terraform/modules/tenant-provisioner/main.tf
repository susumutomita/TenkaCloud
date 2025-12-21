# TenkaCloud Tenant Provisioner Lambda
#
# Application Plane で動作し、EventBridge から TenantOnboarding イベントを受信して
# テナント固有のリソースをプロビジョニングする。
#
# Flow:
# 1. Control Plane が TenantOnboarding イベントを発行
# 2. EventBridge ルールがこの Lambda をトリガー
# 3. Lambda がテナントリソース（S3 等）を作成
# 4. TenantProvisioned イベントを発行

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Lambda IAM Role
resource "aws_iam_role" "lambda_role" {
  name = "${var.name_prefix}-tenant-provisioner-role"

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

  tags = var.tags
}

# Lambda Basic Execution Policy
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# EventBridge PutEvents Policy
resource "aws_iam_role_policy" "eventbridge" {
  name = "${var.name_prefix}-tenant-provisioner-eventbridge"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "events:PutEvents"
        Resource = var.event_bus_arn
      }
    ]
  })
}

# S3 Policy for tenant resources
resource "aws_iam_role_policy" "s3_access" {
  name = "${var.name_prefix}-tenant-provisioner-s3"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:HeadBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.data_bucket_name}",
          "arn:aws:s3:::${var.data_bucket_name}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:HeadBucket",
          "s3:PutObject"
        ]
        Resource = "arn:aws:s3:::tenkacloud-*"
      }
    ]
  })
}

# Dead Letter Queue for failed invocations
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-tenant-provisioner-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = var.tags
}

# SQS Policy for Lambda DLQ
resource "aws_iam_role_policy" "sqs_dlq" {
  name = "${var.name_prefix}-tenant-provisioner-sqs"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.dlq.arn
      }
    ]
  })
}

# Lambda Function
resource "aws_lambda_function" "tenant_provisioner" {
  function_name = "${var.name_prefix}-tenant-provisioner"
  role          = aws_iam_role.lambda_role.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  timeout       = 120
  memory_size   = 256

  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  environment {
    variables = {
      EVENT_BUS_NAME                      = var.event_bus_name
      DATA_BUCKET_NAME                    = var.data_bucket_name
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  tags = var.tags
}

# EventBridge Rule for TenantOnboarding events
resource "aws_cloudwatch_event_rule" "tenant_onboarding" {
  name           = "${var.name_prefix}-tenant-onboarding"
  event_bus_name = var.event_bus_name

  event_pattern = jsonencode({
    source      = ["tenkacloud.control-plane"]
    detail-type = ["TenantOnboarding"]
  })

  tags = var.tags
}

# EventBridge Target
resource "aws_cloudwatch_event_target" "tenant_provisioner" {
  rule           = aws_cloudwatch_event_rule.tenant_onboarding.name
  event_bus_name = var.event_bus_name
  target_id      = "tenant-provisioner"
  arn            = aws_lambda_function.tenant_provisioner.arn

  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }
}

# Lambda permission for EventBridge
resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tenant_provisioner.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.tenant_onboarding.arn
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${aws_lambda_function.tenant_provisioner.function_name}"
  retention_in_days = 14

  tags = var.tags
}
