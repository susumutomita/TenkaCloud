# TenkaCloud Development Environment
#
# This configuration sets up the development infrastructure:
# - DynamoDB table for data storage
# - Auth0 applications for authentication

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
  }

  # For production, use remote backend (S3 + DynamoDB)
  # backend "s3" {
  #   bucket         = "tenkacloud-terraform-state"
  #   key            = "dev/terraform.tfstate"
  #   region         = "ap-northeast-1"
  #   dynamodb_table = "tenkacloud-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "TenkaCloud"
      Environment = "dev"
      ManagedBy   = "Terraform"
    }
  }
}

provider "auth0" {
  domain        = var.auth0_domain
  client_id     = var.auth0_client_id
  client_secret = var.auth0_client_secret
}

# DynamoDB Module
module "dynamodb" {
  source = "../../modules/dynamodb"

  table_name                    = "TenkaCloud-dev"
  enable_point_in_time_recovery = false # Disable for dev to reduce costs
  enable_stream                 = true  # Enable for tenant provisioning

  tags = {
    Environment = "dev"
  }
}

# EventBridge Module - Tenant Lifecycle Events
module "eventbridge" {
  source = "../../modules/eventbridge"

  name_prefix = "tenkacloud-dev"

  tags = {
    Environment = "dev"
  }
}

# Provisioning Lambda Module
# Note: Lambda zip must be built before applying
# Run: cd backend/services/control-plane/provisioning && bun run deploy
module "provisioning_lambda" {
  source = "../../modules/provisioning-lambda"

  name_prefix         = "tenkacloud-dev"
  dynamodb_stream_arn = module.dynamodb.stream_arn
  dynamodb_table_arn  = module.dynamodb.table_arn
  dynamodb_table_name = module.dynamodb.table_name
  event_bus_arn       = module.eventbridge.event_bus_arn
  event_bus_name      = module.eventbridge.event_bus_name
  lambda_zip_path     = "${path.module}/../../../../backend/services/control-plane/provisioning/lambda.zip"

  tags = {
    Environment = "dev"
  }
}

# Auth0 Module
module "auth0" {
  source = "../../modules/auth0"

  api_identifier = "https://api.dev.tenkacloud.com"

  control_plane_callbacks   = ["http://localhost:13000/api/auth/callback/auth0"]
  control_plane_logout_urls = ["http://localhost:13000"]
  control_plane_web_origins = ["http://localhost:13000"]

  application_plane_callbacks   = ["http://localhost:13001/api/auth/callback/auth0"]
  application_plane_logout_urls = ["http://localhost:13001"]
  application_plane_web_origins = ["http://localhost:13001"]
}
