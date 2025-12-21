variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "tenkacloud"
}

variable "tenant_id" {
  description = "Unique identifier for the tenant"
  type        = string
}

variable "tenant_slug" {
  description = "URL-friendly slug for the tenant"
  type        = string
}

variable "tenant_tier" {
  description = "Tenant tier (FREE, PRO, ENTERPRISE)"
  type        = string
  default     = "FREE"

  validation {
    condition     = contains(["FREE", "PRO", "ENTERPRISE"], var.tenant_tier)
    error_message = "tenant_tier must be one of: FREE, PRO, ENTERPRISE"
  }
}

variable "dynamodb_table_arn" {
  description = "ARN of the main DynamoDB table"
  type        = string
}

variable "oidc_provider_arn" {
  description = "ARN of the OIDC provider (Auth0)"
  type        = string
}

variable "oidc_provider_url" {
  description = "URL of the OIDC provider (without https://)"
  type        = string
}

variable "oidc_audience" {
  description = "OIDC audience for token validation"
  type        = string
}

variable "create_s3_bucket" {
  description = "Whether to create an S3 bucket for the tenant"
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
