variable "table_name" {
  description = "Name of the DynamoDB table"
  type        = string
  default     = "TenkaCloud"
}

variable "enable_point_in_time_recovery" {
  description = "Enable point-in-time recovery for the table"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to the DynamoDB table"
  type        = map(string)
  default     = {}
}

variable "enable_stream" {
  description = "Enable DynamoDB Streams for event-driven processing"
  type        = bool
  default     = false
}

variable "read_capacity" {
  description = "Provisioned read capacity units (minimum 1, free tier: 25/month)"
  type        = number
  default     = 1
}

variable "write_capacity" {
  description = "Provisioned write capacity units (minimum 1, free tier: 25/month)"
  type        = number
  default     = 1
}
