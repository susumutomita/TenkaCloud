# TenkaCloud Provisioning Completion Lambda
#
# Control Plane で動作し、EventBridge から TenantProvisioned イベントを受信して
# DynamoDB のテナントレコードの provisioningStatus を更新する。
#
# Flow:
# 1. Application Plane の tenant-provisioner が TenantProvisioned イベント発行
# 2. EventBridge ルールがこの Lambda をトリガー
# 3. DynamoDB のテナントレコードを PROVISIONED または FAILED に更新

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Lambda IAM Role
resource "aws_iam_role" "lambda_role" {
  name = "${var.name_prefix}-provisioning-completion-role"

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

# DynamoDB Policy for updating tenant status
resource "aws_iam_role_policy" "dynamodb" {
  name = "${var.name_prefix}-provisioning-completion-dynamodb"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "dynamodb:UpdateItem"
        Resource = var.dynamodb_table_arn
      }
    ]
  })
}

# Dead Letter Queue for failed invocations
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-provisioning-completion-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = var.tags
}

# SQS Policy for Lambda DLQ
resource "aws_iam_role_policy" "sqs_dlq" {
  name = "${var.name_prefix}-provisioning-completion-sqs"
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
resource "aws_lambda_function" "provisioning_completion" {
  function_name = "${var.name_prefix}-provisioning-completion"
  role          = aws_iam_role.lambda_role.arn
  handler       = "handler.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 128

  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  environment {
    variables = {
      DYNAMODB_TABLE                      = var.dynamodb_table_name
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  tags = var.tags
}

# EventBridge Rule for TenantProvisioned events
resource "aws_cloudwatch_event_rule" "tenant_provisioned" {
  name           = "${var.name_prefix}-tenant-provisioned"
  event_bus_name = var.event_bus_name

  event_pattern = jsonencode({
    source      = ["tenkacloud.application-plane"]
    detail-type = ["TenantProvisioned"]
  })

  tags = var.tags
}

# EventBridge Target
resource "aws_cloudwatch_event_target" "provisioning_completion" {
  rule           = aws_cloudwatch_event_rule.tenant_provisioned.name
  event_bus_name = var.event_bus_name
  target_id      = "provisioning-completion"
  arn            = aws_lambda_function.provisioning_completion.arn

  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }
}

# Lambda permission for EventBridge
resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.provisioning_completion.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.tenant_provisioned.arn
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${aws_lambda_function.provisioning_completion.function_name}"
  retention_in_days = 14

  tags = var.tags
}
