import { describe, expect, it } from "vitest";
import { controlDataBackendEnv } from "../../lib/problem-deploy/control-data-backend-env";

/**
 * Issue #2290: control-plane data backend フラグを Lambda env へ落とす CDK helper の
 * 分岐を pin する (`audit-log-env.test.ts` の mirror)。
 *
 * - `dynamodb` (default) → env を足さない ({}) = 既存テンプレートと byte 互換 (factory も unset で
 *   dynamodb に fallback するので挙動不変)
 * - `turso` / `sql` → `CONTROL_DATA_BACKEND="<backend>"` を注入し cold-start factory が SQLite 実装を選ぶ
 */
describe("controlDataBackendEnv (#2290)", () => {
  it("should return an empty object for the default dynamodb backend (byte-compat)", () => {
    expect(controlDataBackendEnv("dynamodb")).toEqual({});
  });

  it("should inject CONTROL_DATA_BACKEND='turso' when the turso backend is selected", () => {
    expect(controlDataBackendEnv("turso")).toEqual({ CONTROL_DATA_BACKEND: "turso" });
  });

  it("should inject CONTROL_DATA_BACKEND='sql' when the sql backend is selected", () => {
    expect(controlDataBackendEnv("sql")).toEqual({ CONTROL_DATA_BACKEND: "sql" });
  });
});
