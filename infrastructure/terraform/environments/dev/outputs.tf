output "dynamodb_table_name" {
  description = "Name of the DynamoDB table"
  value       = module.dynamodb.table_name
}

output "dynamodb_table_arn" {
  description = "ARN of the DynamoDB table"
  value       = module.dynamodb.table_arn
}

output "dynamodb_stream_arn" {
  description = "ARN of the DynamoDB Stream"
  value       = module.dynamodb.stream_arn
}

output "event_bus_name" {
  description = "Name of the tenant events EventBridge bus"
  value       = module.eventbridge.event_bus_name
}

output "event_bus_arn" {
  description = "ARN of the tenant events EventBridge bus"
  value       = module.eventbridge.event_bus_arn
}

output "provisioning_lambda_name" {
  description = "Name of the provisioning Lambda function"
  value       = module.provisioning_lambda.function_name
}

output "provisioning_lambda_arn" {
  description = "ARN of the provisioning Lambda function"
  value       = module.provisioning_lambda.function_arn
}
