output "dynamodb_table_name" {
  description = "Name of the DynamoDB table"
  value       = module.dynamodb.table_name
}

output "dynamodb_table_arn" {
  description = "ARN of the DynamoDB table"
  value       = module.dynamodb.table_arn
}

output "auth0_control_plane_client_id" {
  description = "Client ID for Control Plane Auth0 application"
  value       = module.auth0.control_plane_client_id
}

output "auth0_control_plane_client_secret" {
  description = "Client secret for Control Plane Auth0 application"
  value       = module.auth0.control_plane_client_secret
  sensitive   = true
}

output "auth0_application_plane_client_id" {
  description = "Client ID for Application Plane Auth0 application"
  value       = module.auth0.application_plane_client_id
}

output "auth0_application_plane_client_secret" {
  description = "Client secret for Application Plane Auth0 application"
  value       = module.auth0.application_plane_client_secret
  sensitive   = true
}

output "auth0_api_identifier" {
  description = "Identifier for the Auth0 API"
  value       = module.auth0.api_identifier
}

# EventBridge Outputs
output "event_bus_name" {
  description = "Name of the tenant events EventBridge bus"
  value       = module.eventbridge.event_bus_name
}

output "event_bus_arn" {
  description = "ARN of the tenant events EventBridge bus"
  value       = module.eventbridge.event_bus_arn
}

# Provisioning Lambda Outputs
output "provisioning_lambda_name" {
  description = "Name of the provisioning Lambda function"
  value       = module.provisioning_lambda.function_name
}

output "provisioning_lambda_arn" {
  description = "ARN of the provisioning Lambda function"
  value       = module.provisioning_lambda.function_arn
}

# DynamoDB Stream
output "dynamodb_stream_arn" {
  description = "ARN of the DynamoDB Stream"
  value       = module.dynamodb.stream_arn
}
