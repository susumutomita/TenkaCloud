# Hello Multicloud (gcp-hello target).
#
# Deployed by GCP Infrastructure Manager into the per-team project declared in
# the team's WIF deploy credential (projectId / location). Stands up exactly one
# free-tier resource: a scale-to-zero Cloud Run service serving Google's stock
# hello container over HTTPS. The composite-probe scorer GETs the GcpHelloUrl
# output; there is nothing else to operate.
#
# The TenkaCloud GCP adapter injects exactly three input values on every deploy
# (tenkacloud_name_prefix / tenkacloud_problem_id / tenkacloud_team), so this
# module declares them and nothing else without a default.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 6.0"
    }
  }
}

variable "tenkacloud_name_prefix" {
  type        = string
  description = "Injected by the TenkaCloud GCP adapter: per-target deployment name prefix."
}

variable "tenkacloud_problem_id" {
  type        = string
  description = "Injected by the TenkaCloud GCP adapter: the composite problem id."
}

variable "tenkacloud_team" {
  type        = string
  description = "Injected by the TenkaCloud GCP adapter: the team slug."
}

variable "project_id" {
  type        = string
  default     = ""
  description = "Optional project override. Infrastructure Manager normally supplies the deployment project via its execution environment; set this only when yours does not."
}

variable "region" {
  type        = string
  default     = "asia-northeast1"
  description = "Region for the hello Cloud Run service."
}

provider "google" {
  project = var.project_id != "" ? var.project_id : null
  region  = var.region
}

locals {
  # Cloud Run service names are lowercase RFC-1035 labels of at most 63 chars.
  service_name = trimsuffix(substr(lower(var.tenkacloud_name_prefix), 0, 48), "-")
}

resource "google_cloud_run_v2_service" "hello" {
  name     = local.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    # Scale-to-zero keeps the idle cost at zero; one instance cap keeps any
    # probe traffic inside the Cloud Run free tier.
    scaling {
      max_instance_count = 1
    }
    containers {
      # Google's stock hello container: answers 200 on GET /. The problem is a
      # smoke test, so the app itself is deliberately not ours to maintain.
      image = "gcr.io/cloudrun/hello"
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
    }
  }

  labels = {
    tenkacloud-problem = var.tenkacloud_problem_id
    tenkacloud-team    = var.tenkacloud_team
  }
}

# The scorer probes anonymously, so the hello endpoint is public. Note: an org
# policy that blocks allUsers (domain-restricted sharing) will reject this
# binding -- use a project where public Cloud Run access is permitted.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.hello.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "GcpHelloUrl" {
  description = "HTTPS hello endpoint probed by the composite-probe scorer. Non-sensitive."
  value       = google_cloud_run_v2_service.hello.uri
}
