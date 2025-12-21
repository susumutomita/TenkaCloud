# TenkaCloud Local Environment (LocalStack)
#
# This configuration deploys to LocalStack for local development and testing.
# Run: docker-compose up -d localstack
# Then: terraform init && terraform apply

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# LocalStack Provider Configuration
provider "aws" {
  region                      = "ap-northeast-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    dynamodb       = "http://localhost:4566"
    lambda         = "http://localhost:4566"
    eventbridge    = "http://localhost:4566"
    cloudwatchlogs = "http://localhost:4566"
    s3             = "http://localhost:4566"
    iam            = "http://localhost:4566"
    sts            = "http://localhost:4566"
    sqs            = "http://localhost:4566"
  }

  default_tags {
    tags = {
      Project     = "TenkaCloud"
      Environment = "local"
      ManagedBy   = "Terraform"
    }
  }
}

# DynamoDB Module
module "dynamodb" {
  source = "../../modules/dynamodb"

  table_name                    = "TenkaCloud-local"
  enable_point_in_time_recovery = false
  enable_stream                 = true

  tags = {
    Environment = "local"
  }
}

# EventBridge Module
module "eventbridge" {
  source = "../../modules/eventbridge"

  name_prefix = "tenkacloud-local"

  tags = {
    Environment = "local"
  }
}

# Provisioning Lambda Module (Control Plane)
module "provisioning_lambda" {
  source = "../../modules/provisioning-lambda"

  name_prefix         = "tenkacloud-local"
  dynamodb_stream_arn = module.dynamodb.stream_arn
  dynamodb_table_arn  = module.dynamodb.table_arn
  dynamodb_table_name = module.dynamodb.table_name
  event_bus_arn       = module.eventbridge.event_bus_arn
  event_bus_name      = module.eventbridge.event_bus_name
  lambda_zip_path     = "${path.module}/../../../../backend/services/control-plane/provisioning/lambda.zip"

  tags = {
    Environment = "local"
  }
}

# S3 Bucket for tenant data (Pool model)
# Created manually via AWS CLI: aws s3 mb s3://tenkacloud-data-local
# Note: LocalStack S3 is slow with Terraform, so we manage it externally

# Tenant Provisioner Lambda Module (Application Plane)
module "tenant_provisioner" {
  source = "../../modules/tenant-provisioner"

  name_prefix      = "tenkacloud-local"
  event_bus_arn    = module.eventbridge.event_bus_arn
  event_bus_name   = module.eventbridge.event_bus_name
  data_bucket_name = "tenkacloud-data-local" # Managed externally
  lambda_zip_path  = "${path.module}/../../../../backend/services/application-plane/tenant-provisioner/lambda.zip"

  tags = {
    Environment = "local"
  }
}

# Provisioning Completion Lambda Module (Control Plane)
# Receives TenantProvisioned events and updates tenant status
module "provisioning_completion" {
  source = "../../modules/provisioning-completion"

  name_prefix         = "tenkacloud-local"
  event_bus_name      = module.eventbridge.event_bus_name
  dynamodb_table_arn  = module.dynamodb.table_arn
  dynamodb_table_name = module.dynamodb.table_name
  lambda_zip_path     = "${path.module}/../../../../backend/services/control-plane/provisioning-completion/lambda.zip"

  tags = {
    Environment = "local"
  }
}
