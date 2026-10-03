import type { Context } from "hono";
import { resolveTenantId } from "../deploy-handler/auth.js";
import { type AuditOutcome, extractAuditContext, writeAuditEvent } from "../shared/audit-log.js";

/**
 * [#950 follow-up] event-handler の mutating route から admin 監査行を 1 行で残す helper。
 *
 * 旧状態: tenant 監査ログ (`監査ログ` 画面) に出るのは competitor-accounts-handler が手書きで
 * `writeAuditEvent` を仕込んだ操作だけで、 event lifecycle (作成 / 終了 / 削除 / deploy / lock /
 * archive / schedule / notification) は 1 行も記録されていなかった。 本 helper は
 * competitor-accounts-handler と同じ pattern (= resolveTenantId + extractAuditContext +
 * best-effort write) を集約し、 各 route が success path で 1 行呼ぶだけにする。
 *
 * write は fire-and-forget (`void`)。 response latency を audit DDB に絡めない。 env
 * `ADMIN_AUDIT_LOG_TABLE_NAME` 未配線なら no-op (= writeAuditEvent 側で吸収)。
 */
export function auditEventAction(
  c: Context,
  action: string,
  target: string,
  outcome: AuditOutcome = "success",
): void {
  const ctx = extractAuditContext(c);
  void writeAuditEvent({
    tenantId: resolveTenantId(c),
    actor: ctx.actor,
    ...(ctx.actorUsername ? { actorUsername: ctx.actorUsername } : {}),
    action,
    outcome,
    target,
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    occurredAtMs: Date.now(),
  });
}
