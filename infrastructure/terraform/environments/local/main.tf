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

# Provisioning Lambda Module
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
