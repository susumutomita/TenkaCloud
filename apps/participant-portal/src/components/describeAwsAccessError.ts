import type { PortalAssumeRoleError } from "../api/portal-client";

type TranslateFn = (key: string, vars?: Record<string, string>) => string;

/** Older responses retain their stage-based message; only fixed API names are displayed. */
export function describeAwsAccessError(err: PortalAssumeRoleError, t: TranslateFn): string {
  if (err.operation && err.operation !== "sts:AssumeRole") {
    return t("sso_credentials.cli.operation_failed", {
      operation: err.operation,
      reason: err.reason,
    });
  }
  return t("sso_credentials.cli.assume_role_failed", {
    stage: t(`sso_credentials.cli.stage_${err.stage}`),
    reason: err.reason,
  });
}
