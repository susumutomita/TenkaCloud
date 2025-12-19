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

output "auth0_application_plane_client_id" {
  description = "Client ID for Application Plane Auth0 application"
  value       = module.auth0.application_plane_client_id
}

output "auth0_api_identifier" {
  description = "Identifier for the Auth0 API"
  value       = module.auth0.api_identifier
}
