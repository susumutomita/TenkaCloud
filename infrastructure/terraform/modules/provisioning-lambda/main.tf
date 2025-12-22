# TenkaCloud Provisioning Lambda
#
# This Lambda processes DynamoDB Stream events and triggers tenant provisioning.
# Flow:
# 1. DynamoDB Stream (Tenant INSERT/MODIFY/DELETE)
# 2. This Lambda processes the event
# 3. Publishes to EventBridge for downstream processing
# 4. Invokes Terraform for tenant resource provisioning

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# Lambda IAM Role
resource "aws_iam_role" "lambda_role" {
  name = "${var.name_prefix}-provisioning-lambda-role"

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

# DynamoDB Stream Read Policy (only if stream is enabled)
resource "aws_iam_role_policy" "dynamodb_stream" {
  count = var.enable_stream_trigger ? 1 : 0
  name  = "${var.name_prefix}-dynamodb-stream"
  role  = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams"
        ]
        Resource = var.dynamodb_stream_arn
      }
    ]
  })
}

# EventBridge PutEvents Policy
resource "aws_iam_role_policy" "eventbridge" {
  name = "${var.name_prefix}-eventbridge"
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

# DynamoDB Read Policy (for tenant data)
resource "aws_iam_role_policy" "dynamodb_read" {
  name = "${var.name_prefix}-dynamodb-read"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem"
        ]
        Resource = [
          var.dynamodb_table_arn,
          "${var.dynamodb_table_arn}/index/*"
        ]
      }
    ]
  })
}

# Dead Letter Queue for failed invocations
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-provisioning-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = var.tags
}

# SQS Policy for Lambda DLQ
resource "aws_iam_role_policy" "sqs_dlq" {
  name = "${var.name_prefix}-sqs-dlq"
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
resource "aws_lambda_function" "provisioning" {
  function_name = "${var.name_prefix}-provisioning"
  role          = aws_iam_role.lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 60
  memory_size   = 256

  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  environment {
    variables = {
      EVENT_BUS_NAME                      = var.event_bus_name
      DYNAMODB_TABLE                      = var.dynamodb_table_name
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  tags = var.tags
}

# DynamoDB Stream Event Source Mapping (only if stream is enabled)
resource "aws_lambda_event_source_mapping" "dynamodb_stream" {
  count             = var.enable_stream_trigger ? 1 : 0
  event_source_arn  = var.dynamodb_stream_arn
  function_name     = aws_lambda_function.provisioning.arn
  starting_position = "LATEST"
  batch_size        = 10

  # Retry configuration for DynamoDB Streams
  maximum_retry_attempts       = 3
  maximum_record_age_in_seconds = 3600 # 1 hour

  # Send failed records to DLQ
  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.dlq.arn
    }
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        dynamodb = {
          Keys = {
            PK = {
              S = [{ prefix = "TENANT#" }]
            }
            SK = {
              S = ["METADATA"]
            }
          }
        }
      })
    }
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${aws_lambda_function.provisioning.function_name}"
  retention_in_days = 14

  tags = var.tags
}
