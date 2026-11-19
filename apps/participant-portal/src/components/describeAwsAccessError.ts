import { toErrorMessage } from "@tenkacloud/web-kit";
import {
  PortalAssumeRoleError,
  PortalNetworkError,
  PortalValidationError,
} from "../api/portal-client";

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

function errorCodeOf(err: PortalNetworkError | PortalValidationError): string | undefined {
  if (err instanceof PortalValidationError) return err.errorCode;
  try {
    const body: unknown = JSON.parse(err.message.slice(err.message.indexOf(": ") + 2));
    const code = (body as { error?: unknown } | null)?.error;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Messages for the SSO page's access requests. The API's JSON and field names never reach the
 * participant; each case says what to do next.
 */
export function describeAccessError(err: unknown, t: TranslateFn): string {
  if (err instanceof PortalAssumeRoleError) return describeAwsAccessError(err, t);
  if (err instanceof PortalNetworkError || err instanceof PortalValidationError) {
    const code = errorCodeOf(err);
    if (code === "guest_not_ready" || code === "not_ready")
      return t("sso_credentials.error_not_ready");
    if (code === "console_unavailable") return t("sso_credentials.error_unsupported");
    return t("sso_credentials.error_generic");
  }
  // Local checks (such as an unusable endpoint) already carry a readable message.
  return toErrorMessage(err);
}
