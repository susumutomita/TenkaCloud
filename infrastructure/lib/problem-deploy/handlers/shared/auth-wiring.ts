import type { Context, MiddlewareHandler } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  TenantSuspendedError,
} from "../deploy-handler/auth.js";

/**
 * Shared auth-error onError handler + role-check middleware for the tenant-facing
 * Hono Lambdas (deploy-handler / event-handler). Both Lambdas authenticate via the
 * tenant API Gateway + Cognito JWT authorizer and map the same three auth error
 * classes (`MissingTenantClaimError` → 401, `ForbiddenRoleError` → 403,
 * `TenantSuspendedError` → 403) plus a generic 500 fall-through.
 *
 * #559 defensive layer: an exception that escapes a handler's own try/catch (e.g.
 * `resolveTenantId(c)` throwing, a middleware throw, a type mismatch) would
 * otherwise reach the API Gateway layer as a 500 with **no CORS headers**, so the
 * browser only sees "Failed to fetch" and cannot read the response body. Returning
 * the error as a Hono `Response` from `onError` lets the CORS middleware attach
 * `Access-Control-*` headers, so the browser can read the `error` field.
 *
 * The exception `message` stays in CloudWatch Logs **only** and is never placed in
 * the response body (= internal IAM ARNs / table names / stack traces must not leak
 * to the browser, PR-570 review). Operators read the `<logPrefix> uncaught handler
 * error` line in CloudWatch Logs for detail.
 */

/** `onError` handler signature accepted by `Hono#onError`. */
export type AuthErrorHandler = (err: Error, c: Context) => Response | Promise<Response>;

/**
 * Build the `app.onError` handler that maps the tenant auth error classes to their
 * HTTP statuses. `logPrefix` is the bracketed source tag used on every log line
 * (e.g. `"[deploy]"` / `"[events]"`); it is the only difference between the two
 * call sites.
 */
export function buildAuthErrorHandler({ logPrefix }: { logPrefix: string }): AuthErrorHandler {
  return (err, c) => {
    // Issue #686: a JWT without custom:tenantId is a 401 fail-closed (= avoid silent
    // "unknown-tenant" writes). The frontend renders "please re-login" via
    // FriendlyErrorAlert.
    if (err instanceof MissingTenantClaimError) {
      console.warn(`${logPrefix} missing tenantId claim`, { path: c.req.path });
      return c.json(
        { error: "missing_tenant_claim", message: err.message },
        StatusCodes.UNAUTHORIZED,
      );
    }
    // Issue #854 / ADR-020 Phase B.1 (#948): a role mismatch is 403; detail stays in
    // logs only (= do not teach an attacker the attack surface). The frontend maps the
    // "forbidden_role" error code via FriendlyErrorAlert.
    if (err instanceof ForbiddenRoleError) {
      console.warn(`${logPrefix} forbidden role`, {
        path: c.req.path,
        method: c.req.method,
        actualRole: err.actualRole,
        requiredRoles: err.requiredRoles,
      });
      return c.json(
        {
          error: "forbidden_role",
          message: "あなたの tenant role ではこの操作を実行できません",
        },
        StatusCodes.FORBIDDEN,
      );
    }
    if (err instanceof TenantSuspendedError) {
      console.warn(`${logPrefix} tenant suspended`, { path: c.req.path, method: c.req.method });
      return c.json(
        {
          error: "tenant_suspended",
          message: err.message,
        },
        StatusCodes.FORBIDDEN,
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`${logPrefix} uncaught handler error`, { path: c.req.path, message });
    return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  };
}

/**
 * Build the blanket role-check middleware. It requires that the request carries one
 * of `roles` (= an authenticated tenant user), then defers per-route narrowing to
 * each route's first-line `requireRole(c, [...])`. `/healthz` is skipped for both
 * authn and authz (= the API Gateway side bypasses auth for it).
 *
 * `healthzPath` is matched with a trailing-segment check (`endsWith`), so it matches
 * `/healthz`, `/events/healthz`, etc. This preserves the prior behaviour of both call
 * sites: the deploy handler's extra `path === "/healthz"` test was redundant because
 * `"/healthz".endsWith("/healthz")` is already true.
 */
export function createRoleCheckMiddleware({
  healthzPath,
  roles,
}: {
  healthzPath: string;
  roles: readonly string[];
}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.endsWith(healthzPath)) {
      return next();
    }
    requireRole(c, roles);
    return next();
  };
}
