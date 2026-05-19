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
 * tenant-template/identity-provider.ts (TenantAdmin 側、 ADR-020 Phase E) と同方針 — TOTP only /
 * SMS なし / 12 文字以上 / 4 種混在 を baseline とする。
 */
describe("SystemAdmin の Cognito UserPool MFA / password policy (Issue #1035)", () => {
  it("MFA は REQUIRED (= ON) に強制すべき", () => {
    expect(SYSTEM_ADMIN_MFA_CONFIGURATION).toBe("ON");
  });

  it("第二要素は TOTP (SOFTWARE_TOKEN_MFA) のみとし SMS は許可しないべき", () => {
    expect(SYSTEM_ADMIN_ENABLED_MFAS).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect(SYSTEM_ADMIN_ENABLED_MFAS).not.toContain("SMS_MFA");
  });

  it("password 最小長は 12 文字以上であるべき (SBT default 8 文字を上書き)", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.MinimumLength).toBeGreaterThanOrEqual(12);
  });

  it("password は lower / upper / number / symbol の 4 種を必須にすべき", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireLowercase).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireUppercase).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireNumbers).toBe(true);
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.RequireSymbols).toBe(true);
  });

  it("一時パスワード有効期間は 7 日以内に制限すべき (= 招待後の総当たり面を縮減)", () => {
    expect(SYSTEM_ADMIN_PASSWORD_POLICY.TemporaryPasswordValidityDays).toBeLessThanOrEqual(7);
  });
});
