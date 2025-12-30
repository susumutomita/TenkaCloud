variable "api_identifier" {
  description = "Identifier for the Auth0 API resource server"
  type        = string
  default     = "https://api.tenkacloud.com"
}

# Control Plane URLs
variable "control_plane_callbacks" {
  description = "Allowed callback URLs for Control Plane"
  type        = list(string)
  default     = ["http://localhost:13000/api/auth/callback/auth0"]
}

variable "control_plane_logout_urls" {
  description = "Allowed logout URLs for Control Plane"
  type        = list(string)
  default     = ["http://localhost:13000"]
}

variable "control_plane_web_origins" {
  description = "Allowed web origins for Control Plane"
  type        = list(string)
  default     = ["http://localhost:13000"]
}

# Application Plane URLs
variable "application_plane_callbacks" {
  description = "Allowed callback URLs for Application Plane"
  type        = list(string)
  default     = ["http://localhost:13001/api/auth/callback/auth0"]
}

variable "application_plane_logout_urls" {
  description = "Allowed logout URLs for Application Plane"
  type        = list(string)
  default     = ["http://localhost:13001"]
}

variable "application_plane_web_origins" {
  description = "Allowed web origins for Application Plane"
  type        = list(string)
  default     = ["http://localhost:13001"]
}
