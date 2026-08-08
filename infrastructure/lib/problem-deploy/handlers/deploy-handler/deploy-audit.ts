import type { Context } from "hono";
import { extractAuditContext, writeAuditEvent } from "../shared/audit-log.js";

/**
 * Issue #2948 / #2955: deploy API の mutating 操作を admin audit log に残す helper。
 *
 * machine (M2M) 経路が到達できる mutating route はこの 2 本だけなので、ここが「CI / agent が
 * 何をしたか」の正本になる。human の同じ操作も同じ行を書く — 経路によって監査の粒度を
 * 変えない。actor は `extractAuditContext` が human の `sub` か `m2m:<clientId>` に振り分ける。
 *
 * best-effort write なので、失敗しても deploy / retry の成否には影響しない
 * (`writeAuditEvent` 自身が握る)。
 */

async function record(
  c: Context,
  event: {
    readonly tenantId: string;
    readonly action: string;
    readonly outcome: "success" | "error";
    readonly target: string;
  },
): Promise<void> {
  const auditContext = extractAuditContext(c);
  await writeAuditEvent({
    tenantId: event.tenantId,
    actor: auditContext.actor,
    actorUsername: auditContext.actorUsername,
    action: event.action,
    outcome: event.outcome,
    target: event.target,
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
    occurredAtMs: Date.now(),
  });
}

/** `POST /problems/:problemId/deploy`。target は problemId。 */
export function recordDeployAudit(
  c: Context,
  tenantId: string,
  problemId: string,
  outcome: "success" | "error",
): Promise<void> {
  return record(c, { tenantId, action: "deploy_problem", outcome, target: problemId });
}

/** `POST /deployments/retry`。target は再投入した件数。 */
export function recordRetryAudit(
  c: Context,
  tenantId: string,
  jobCount: number,
  outcome: "success" | "error",
): Promise<void> {
  return record(c, {
    tenantId,
    action: "retry_deployments",
    outcome,
    target: String(jobCount),
  });
}
