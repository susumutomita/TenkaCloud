output "control_plane_client_id" {
  description = "Client ID for Control Plane application"
  value       = auth0_client.control_plane.id
}

output "control_plane_client_secret" {
  description = "Client secret for Control Plane application"
  value       = auth0_client_credentials.control_plane.client_secret
  sensitive   = true
}

output "application_plane_client_id" {
  description = "Client ID for Application Plane application"
  value       = auth0_client.application_plane.id
}

output "application_plane_client_secret" {
  description = "Client secret for Application Plane application"
  value       = auth0_client_credentials.application_plane.client_secret
  sensitive   = true
}

output "api_identifier" {
  description = "Identifier for the API resource server"
  value       = auth0_resource_server.api.identifier
}
