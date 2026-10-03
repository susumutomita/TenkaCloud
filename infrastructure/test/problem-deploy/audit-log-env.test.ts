import { describe, expect, it } from "vitest";
import { auditLogEnabledEnv } from "../../lib/problem-deploy/audit-log-env";

/**
 * Issue #2311: 監査ログ feature flag を Lambda env へ落とす CDK helper の分岐を pin する。
 *
 * - default (undefined) / true → env を足さない ({}) = 既存テンプレートと byte 互換
 * - false → `AUDIT_LOG_ENABLED="false"` を注入し handler の writeAuditEvent を no-op 化
 */
describe("auditLogEnabledEnv (#2311)", () => {
  it("should return an empty object when enabled (undefined = default on, byte-compat)", () => {
    expect(auditLogEnabledEnv(undefined)).toEqual({});
  });

  it("should return an empty object when explicitly enabled (true)", () => {
    expect(auditLogEnabledEnv(true)).toEqual({});
  });

  it("should inject AUDIT_LOG_ENABLED='false' only when disabled (false)", () => {
    expect(auditLogEnabledEnv(false)).toEqual({ AUDIT_LOG_ENABLED: "false" });
  });
});
