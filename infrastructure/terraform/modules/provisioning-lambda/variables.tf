variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "tenkacloud"
}

variable "dynamodb_stream_arn" {
  description = "ARN of the DynamoDB Stream to trigger the Lambda (null if stream disabled)"
  type        = string
  default     = null
}

variable "enable_stream_trigger" {
  description = "Whether to enable the DynamoDB Stream trigger"
  type        = bool
  default     = true
}

variable "dynamodb_table_arn" {
  description = "ARN of the DynamoDB table"
  type        = string
}

variable "dynamodb_table_name" {
  description = "Name of the DynamoDB table"
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

variable "lambda_zip_path" {
  description = "Path to the Lambda deployment package"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
