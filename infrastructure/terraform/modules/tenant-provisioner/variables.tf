variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "event_bus_arn" {
  description = "ARN of the EventBridge event bus"
  type        = string
}

variable "event_bus_name" {
  description = "Name of the EventBridge event bus"
  type        = string
}

variable "data_bucket_name" {
  description = "Name of the S3 bucket for tenant data (Pool model)"
  type        = string
}

variable "lambda_zip_path" {
  description = "Path to the Lambda deployment package"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
