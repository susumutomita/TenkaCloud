# Cross-cloud identity recovery (GCP target).
#
# Deployed by GCP Infrastructure Manager. Stands up:
#   * a Workload Identity Pool + AWS provider whose TRUST is intentionally broken,
#   * a service account whose impersonation BINDING for the federated identity is
#     intentionally missing, and
#   * a protected Cloud Run endpoint that requires an authenticated caller.
#
# There is NO service-account key resource anywhere in this module. The keyless
# AWS-to-GCP path is restored by fixing the trust + binding, never by minting a
# key. `google_service_account_key` is deliberately absent and must stay absent.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 6.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project id that hosts this target."
}

variable "project_number" {
  type        = string
  description = "GCP project number (non-sensitive identifier, used in the WIF audience)."
}

variable "region" {
  type        = string
  description = "Region for the protected Cloud Run service."
  default     = "us-central1"
}

variable "aws_account_id" {
  type        = string
  description = "The AWS account id of the aws-workload target. The provider must trust this account."
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_iam_workload_identity_pool" "recovery" {
  workload_identity_pool_id = "cross-cloud-recovery"
  display_name              = "Cross-cloud recovery pool"
  description               = "Federates the AWS recovery workload into GCP without static keys."
}

# INTENTIONALLY BROKEN TRUST.
#
# Two deliberate misconfigurations the participant must repair:
#   1. attribute_condition pins the AWS account to a placeholder that does not
#      match the real aws-workload account, so every federated token is rejected
#      (broken audience / unauthorized caller path).
#   2. allowed_audiences is set to a value the AWS workload never presents, so
#      even a same-account token fails audience validation (broken audience claim).
#
# Remediation: bind the condition to var.aws_account_id and remove / correct the
# allowed_audiences override so the provider validates the intended caller path.
resource "google_iam_workload_identity_pool_provider" "aws" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.recovery.workload_identity_pool_id
  workload_identity_pool_provider_id = "aws-workload"
  display_name                       = "AWS workload provider"

  attribute_mapping = {
    "google.subject"        = "assertion.arn"
    "attribute.aws_account" = "assertion.account"
  }

  # BROKEN: pins to a placeholder account, not the real aws-workload account.
  attribute_condition = "attribute.aws_account == '000000000000'"

  aws {
    account_id = var.aws_account_id
  }

  # BROKEN: the workload never presents this audience.
  oidc {
    allowed_audiences = ["https://example.invalid/never-matches"]
    issuer_uri        = "https://sts.amazonaws.com"
  }
}

# The service account the AWS workload impersonates to reach the protected
# endpoint. It has NO key resource -- impersonation is keyless.
resource "google_service_account" "protected_caller" {
  account_id   = "protected-caller"
  display_name = "Protected endpoint caller"
  description  = "Impersonated by the federated AWS workload. Never issued a static key."
}

# INTENTIONALLY MISSING BINDING.
#
# For keyless impersonation the federated AWS identity must hold
# roles/iam.workloadIdentityUser on protected_caller. That binding is commented
# out so an unbound / unauthorized service-account impersonation fails closed.
#
# Remediation: grant roles/iam.workloadIdentityUser to the federated principal
# `principalSet://iam.googleapis.com/${pool.name}/attribute.aws_account/${aws_account_id}`.
#
# resource "google_service_account_iam_member" "allow_federated_impersonation" {
#   service_account_id = google_service_account.protected_caller.name
#   role               = "roles/iam.workloadIdentityUser"
#   member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.recovery.name}/attribute.aws_account/${var.aws_account_id}"
# }

# The protected GCP endpoint. Cloud Run with authenticated invocation only --
# it must validate the intended caller path, never accept anonymous traffic.
resource "google_cloud_run_v2_service" "protected" {
  name     = "protected-endpoint"
  location = var.region

  template {
    containers {
      # A trivial echo container; the security boundary is the IAM invoker policy,
      # not the app. Returns 200 to any authorized caller on GET /.
      image = "gcr.io/cloudrun/hello"
    }
  }
}

# Only the impersonated service account may invoke the protected endpoint. There
# is deliberately NO allUsers / allAuthenticatedUsers binding, so anonymous
# traffic is rejected and the scorer cannot pass without the keyless path.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.protected.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.protected_caller.email}"
}

output "workload_identity_pool_id" {
  description = "Workload Identity Pool id (non-sensitive). Feed to the AWS target."
  value       = google_iam_workload_identity_pool.recovery.workload_identity_pool_id
}

output "workload_identity_provider_id" {
  description = "Workload Identity Pool provider id (non-sensitive). Feed to the AWS target."
  value       = google_iam_workload_identity_pool_provider.aws.workload_identity_pool_provider_id
}

output "service_account_email" {
  description = "Service account the AWS workload impersonates (identity only, never a key)."
  value       = google_service_account.protected_caller.email
}

output "protected_endpoint_url" {
  description = "HTTPS URL of the protected endpoint (non-sensitive). Feed to the AWS target."
  value       = google_cloud_run_v2_service.protected.uri
}

output "project_number" {
  description = "GCP project number (non-sensitive identifier for the WIF audience)."
  value       = var.project_number
}
