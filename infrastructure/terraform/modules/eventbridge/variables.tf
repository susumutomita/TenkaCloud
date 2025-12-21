variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
  default     = "tenkacloud"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
