-- Issue #2555: tenant-owned deployment-account projection.
-- The OIDC command path fails closed unless the (tenant, account) pair is
-- registered here — the control-store edition of the verified-account check
-- the signed-intent ingress performed against the CompetitorAccounts
-- DynamoDB table (#2362). Rows are registered through the system-admin API,
-- and the resolved role ARN + ExternalId SSM parameter name ride in the
-- frozen deploy event so downstream execution cannot fall back to
-- same-account credentials.
CREATE TABLE competitor_account_projection (
  tenant_id                   TEXT NOT NULL,
  aws_account_id              TEXT NOT NULL,
  competitor_role_arn         TEXT NOT NULL,
  external_id_parameter_name  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, aws_account_id)
);
