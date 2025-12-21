# TenkaCloud Tenant Resources
#
# This module creates per-tenant resources:
# - IAM Role for tenant-scoped AWS access
# - S3 Bucket for tenant artifacts (optional)
# - CloudWatch Log Group for tenant logs
#
# Equivalent to TenantTemplateStack in reference/serverless

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  tenant_prefix = "${var.name_prefix}-${var.tenant_id}"
}

# Tenant IAM Role - for STS Federation from Auth0
resource "aws_iam_role" "tenant_role" {
  name = "${local.tenant_prefix}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = var.oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${var.oidc_provider_url}:aud" = var.oidc_audience
          }
          StringLike = {
            "${var.oidc_provider_url}:sub" = "auth0|*"
          }
        }
      }
    ]
  })

  tags = merge(var.tags, {
    TenantId   = var.tenant_id
    TenantSlug = var.tenant_slug
  })
}

# Tenant DynamoDB Policy - scoped to tenant's partition
resource "aws_iam_role_policy" "tenant_dynamodb" {
  name = "${local.tenant_prefix}-dynamodb"
  role = aws_iam_role.tenant_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = [
          var.dynamodb_table_arn,
          "${var.dynamodb_table_arn}/index/*"
        ]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "TENANT#${var.tenant_id}*",
              "EVENT#*" # Allow event access (for battles)
            ]
          }
        }
      }
    ]
  })
}

# Tenant S3 Bucket (optional - for artifacts, logs, etc.)
resource "aws_s3_bucket" "tenant_bucket" {
  count  = var.create_s3_bucket ? 1 : 0
  bucket = "${local.tenant_prefix}-artifacts"

  tags = merge(var.tags, {
    TenantId   = var.tenant_id
    TenantSlug = var.tenant_slug
  })
}

resource "aws_s3_bucket_versioning" "tenant_bucket" {
  count  = var.create_s3_bucket ? 1 : 0
  bucket = aws_s3_bucket.tenant_bucket[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_bucket" {
  count  = var.create_s3_bucket ? 1 : 0
  bucket = aws_s3_bucket.tenant_bucket[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tenant_bucket" {
  count  = var.create_s3_bucket ? 1 : 0
  bucket = aws_s3_bucket.tenant_bucket[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 Access Policy (if bucket is created)
resource "aws_iam_role_policy" "tenant_s3" {
  count = var.create_s3_bucket ? 1 : 0
  name  = "${local.tenant_prefix}-s3"
  role  = aws_iam_role.tenant_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.tenant_bucket[0].arn,
          "${aws_s3_bucket.tenant_bucket[0].arn}/*"
        ]
      }
    ]
  })
}

# Tenant CloudWatch Log Group
resource "aws_cloudwatch_log_group" "tenant_logs" {
  name              = "/tenkacloud/tenants/${var.tenant_id}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    TenantId   = var.tenant_id
    TenantSlug = var.tenant_slug
  })
}

# CloudWatch Logs Policy
resource "aws_iam_role_policy" "tenant_logs" {
  name = "${local.tenant_prefix}-logs"
  role = aws_iam_role.tenant_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.tenant_logs.arn}:*"
      }
    ]
  })
}
