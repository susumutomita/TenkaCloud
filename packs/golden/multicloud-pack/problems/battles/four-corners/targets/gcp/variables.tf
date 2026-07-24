# Golden composite GCP (Infrastructure Manager) target — root module input variables.
# Reserved runtime: declared and validated, never applied in CI (capabilities.ts
# gcp/infra-manager executable=false, blocked on #2081 live acceptance). Names mirror the
# platform-injected inputs gcp-infra-manager-adapter.ts always sends (#2745).

variable "tenkacloud_name_prefix" {
  description = "Deploy-time unique stack name prefix injected by TenkaCloud (tc-<problem>-<team>)."
  type        = string
}

variable "tenkacloud_problem_id" {
  description = "The problem id this deployment belongs to."
  type        = string
}

variable "tenkacloud_team" {
  description = "The competing team's slug."
  type        = string
}
