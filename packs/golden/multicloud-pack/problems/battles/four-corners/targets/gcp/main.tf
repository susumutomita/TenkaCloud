# Golden composite GCP (Infrastructure Manager) target — a trivial, genuinely deployable
# resource (#2745). Previously an inert `targets/gcp.yaml` comment-only placeholder that no
# materializer could ever zip into a real Infra Manager blueprint; this directory is a real
# Terraform root module instead. Reserved runtime: declared and validated, never applied in CI
# (capabilities.ts gcp/infra-manager executable=false, blocked on #2081 live acceptance).

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

resource "google_storage_bucket" "target" {
  name                        = "${var.tenkacloud_name_prefix}-four-corners-gcp"
  location                    = "ASIA-NORTHEAST1"
  force_destroy               = true
  uniform_bucket_level_access = true

  labels = {
    tenkacloud_problem = var.tenkacloud_problem_id
    tenkacloud_team    = var.tenkacloud_team
  }
}
