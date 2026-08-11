import { describe, expect, it } from "vitest";
import {
  SYSTEM_ADMIN_ENABLED_MFAS,
  SYSTEM_ADMIN_MFA_CONFIGURATION,
  SYSTEM_ADMIN_PASSWORD_POLICY,
} from "../../lib/control-plane/mfa-policy";

/**
 * Issue #1035: SystemAdmin の MFA / password policy が緩む方向に書き換えられないよう値を pin する。
 * ここの定数値は control-plane-stack.ts が SBT 内蔵 UserPool に escape hatch で flush している。
 *
 * tenant-template/identity-provider.ts の TenantAdmin 側と同方針 — TOTP only /
 * SMS なし / 12 文字以上 / 4 種混在 を baseline とする。
 */
describe("SystemAdmin の Cognito UserPool MFA / password policy (Issue #1035)", () => {
  it("should force MFA to REQUIRED (ON)", () => {
    expect(SYSTEM_ADMIN_MFA_CONFIGURATION).toBe("ON");
  });

  it("should accept only TOTP (SOFTWARE_TOKEN_MFA) as the second factor and disallow SMS", () => {
    expect(SYSTEM_ADMIN_ENABLED_MFAS).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect(SYSTEM_ADMIN_ENABLED_MFAS).not.toContain("SMS_MFA");
  });

  it("password minimum length should be 12 or more (overriding SBT default 8)", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.MinimumLength).toBeGreaterThanOrEqual(12);
  });

  it("password should require all 4 of lower / upper / number / symbol", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireLowercase).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireUppercase).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireNumbers).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireSymbols).toBe(true);
  });

  it("temporary-password validity should be limited to within 7 days (shrinking brute-force surface after invite)", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.TemporaryPasswordValidityDays).toBeLessThanOrEqual(7);
  });
});
