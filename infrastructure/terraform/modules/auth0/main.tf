# TenkaCloud Auth0 Configuration
#
# This module configures Auth0 for TenkaCloud:
# - Control Plane Application (admin portal)
# - Application Plane Application (tenant apps)
# - API Resource Server
# - Connections and Rules

terraform {
  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
  }
}

# Control Plane Application (Next.js)
resource "auth0_client" "control_plane" {
  name        = "TenkaCloud Control Plane"
  description = "Admin portal for TenkaCloud platform management"
  app_type    = "regular_web"

  callbacks = var.control_plane_callbacks
  allowed_logout_urls = var.control_plane_logout_urls
  web_origins = var.control_plane_web_origins

  jwt_configuration {
    alg = "RS256"
  }

  oidc_conformant = true
  grant_types = [
    "authorization_code",
    "refresh_token"
  ]

  refresh_token {
    rotation_type   = "rotating"
    expiration_type = "expiring"
    token_lifetime  = 2592000 # 30 days
  }
}

# Application Plane Application (Next.js)
resource "auth0_client" "application_plane" {
  name        = "TenkaCloud Application Plane"
  description = "Tenant application for TenkaCloud battles"
  app_type    = "regular_web"

  callbacks = var.application_plane_callbacks
  allowed_logout_urls = var.application_plane_logout_urls
  web_origins = var.application_plane_web_origins

  jwt_configuration {
    alg = "RS256"
  }

  oidc_conformant = true
  grant_types = [
    "authorization_code",
    "refresh_token"
  ]

  refresh_token {
    rotation_type   = "rotating"
    expiration_type = "expiring"
    token_lifetime  = 2592000 # 30 days
  }
}

# API Resource Server
resource "auth0_resource_server" "api" {
  name        = "TenkaCloud API"
  identifier  = var.api_identifier
  signing_alg = "RS256"

  token_lifetime         = 86400  # 24 hours
  token_lifetime_for_web = 7200   # 2 hours
}

# API Scopes
resource "auth0_resource_server_scopes" "api_scopes" {
  resource_server_identifier = auth0_resource_server.api.identifier

  scopes {
    name        = "read:tenants"
    description = "Read tenant information"
  }

  scopes {
    name        = "write:tenants"
    description = "Create and update tenants"
  }

  scopes {
    name        = "read:events"
    description = "Read event information"
  }

  scopes {
    name        = "write:events"
    description = "Create and update events"
  }

  scopes {
    name        = "admin"
    description = "Full administrative access"
  }
}

# Client Credentials for Control Plane
resource "auth0_client_credentials" "control_plane" {
  client_id             = auth0_client.control_plane.id
  authentication_method = "client_secret_post"
}

# Client Credentials for Application Plane
resource "auth0_client_credentials" "application_plane" {
  client_id             = auth0_client.application_plane.id
  authentication_method = "client_secret_post"
}
