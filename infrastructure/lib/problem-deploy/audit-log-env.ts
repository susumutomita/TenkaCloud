/**
 * Issue #2311: 監査ログ feature flag を Lambda env へ落とす CDK helper。
 *
 * 監査を書く Lambda (deploy-api / event-api / competitor-accounts-api / system-audit-writer /
 * sign-in-audit / admin-insight) は全て `handlers/shared/audit-log.ts` の `writeAuditEvent` を
 * 通り、 その `isAuditLoggingEnabled()` は env `AUDIT_LOG_ENABLED !== "false"` で判定する
 * (= **default on**)。
 *
 * したがって:
 *   - 有効 (default / undefined / true) → env を **足さない** (= 既存テンプレートと byte 互換、
 *     CFn 差分 0、 リグレッションなし)。
 *   - 無効 (false) → `AUDIT_LOG_ENABLED="false"` を注入し handler を no-op 化する
 *     (= 書き込みコスト節約)。
 *
 * 各 Lambda construct が同じ条件式を lockstep で持つと drift の温床になるため
 * (`app-wiring/problem-deploy-backend-props.ts` の教訓)、 1 helper に集約する。
 */
export function auditLogEnabledEnv(auditLogEnabled?: boolean): Record<string, string> {
  return auditLogEnabled === false ? { AUDIT_LOG_ENABLED: "false" } : {};
}
