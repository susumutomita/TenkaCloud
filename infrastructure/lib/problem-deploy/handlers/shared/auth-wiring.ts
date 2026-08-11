import type { Context, MiddlewareHandler } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  resolveTenantId,
  TenantSuspendedError,
} from "../deploy-handler/auth.js";
import { extractAuditContext, writeAuditEvent } from "./audit-log.js";
import { MachineRouteDeniedError, machineActor } from "./machine-principal.js";

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
/**
 * Issue #2948: machine principal の拒否を 403 `forbidden_machine_route` にして監査に残す。
 *
 * human 経路の挙動は一切変わらない (= `MachineRouteDeniedError` は machine token でしか
 * 発生しない)。拒否は #2911 が要求する監査の一部なので、principal が判っているときだけ
 * audit 行を書く。principal を解決できなかった拒否 (`not_a_machine_principal`) は tenant も
 * actor も特定できないため CloudWatch Logs の 1 行に留める (= 偽の tenant 行を作らない)。
 *
 * 独自 `onError` を持つ competitor-accounts-handler からも同じ実装を呼ぶ。
 */
export async function respondMachineRouteDenied(
  err: MachineRouteDeniedError,
  c: Context,
  logPrefix: string,
): Promise<Response> {
  console.warn(`${logPrefix} machine route denied`, {
    path: err.path,
    method: err.method,
    reason: err.reason,
    clientId: err.principal?.clientId,
  });
  if (err.principal) {
    const auditContext = extractAuditContext(c);
    await writeAuditEvent({
      tenantId: err.principal.tenantId,
      actor: machineActor(err.principal),
      action: `${err.method} ${err.path}`,
      outcome: "forbidden",
      target: err.reason,
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
      occurredAtMs: Date.now(),
    });
  }
  return c.json(
    {
      error: "forbidden_machine_route",
      message:
        "この machine credential では、この操作を実行できません (route allowlist または capability の不足)",
    },
    StatusCodes.FORBIDDEN,
  );
}

/**
 * #2954: role 拒否を admin audit log へ書く。competitor-accounts-handler が既に持っていた形と
 * 同じ row を、deploy / event Lambda でも書けるようにしたもの。
 *
 * tenantId が解決できない拒否 (= claim 不在 / 越境) でも `"unknown"` で行を残す。「弾かれた
 * こと自体」が監査対象であり、tenant が引けないからといって記録しないほうが穴になる。
 */
async function writeForbiddenAuditEvent(c: Context, err: ForbiddenRoleError): Promise<void> {
  const auditContext = extractAuditContext(c);
  let tenantId = "unknown";
  try {
    tenantId = resolveTenantId(c);
  } catch {
    // tenantId 不明でも audit は試みる (= competitor-accounts-handler と同じ判断)。
  }
  await writeAuditEvent({
    tenantId,
    actor: auditContext.actor,
    actorUsername: auditContext.actorUsername,
    action: `${c.req.method} ${c.req.path}`,
    outcome: "forbidden",
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
    occurredAtMs: Date.now(),
    extra: {
      actualRole: err.actualRole ?? "(none)",
      requiredRoles: err.requiredRoles.join(","),
    },
  });
}

export function buildAuthErrorHandler({ logPrefix }: { logPrefix: string }): AuthErrorHandler {
  return async (err, c) => {
    if (err instanceof MachineRouteDeniedError) {
      return respondMachineRouteDenied(err, c, logPrefix);
    }
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
    // Issues #854 and #948: a role mismatch is 403; detail stays in
    // logs only (= do not teach an attacker the attack surface). The frontend maps the
    // "forbidden_role" error code via FriendlyErrorAlert.
    if (err instanceof ForbiddenRoleError) {
      console.warn(`${logPrefix} forbidden role`, {
        path: c.req.path,
        method: c.req.method,
        actualRole: err.actualRole,
        requiredRoles: err.requiredRoles,
      });
      // #2954: 拒否を audit 行にも残す。競技運営 API (deploy / event) は今まで console.warn
      // だけで、competitor-accounts だけが行を書いていた。この非対称のせいで「誰が何を試みて
      // 弾かれたか」は Lambda ごとに違う場所を見る必要があり、admin console の audit 画面には
      // deploy / event の拒否が 1 件も出てこなかった。
      await writeForbiddenAuditEvent(c, err);
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
