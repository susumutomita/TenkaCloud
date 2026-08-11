/**
 * Issue #1035: Control Plane (= SystemAdmin) の Cognito UserPool に MFA を強制するための
 * CFn property 値を pin する。 SBT 0.3.9 が UserPool を内部生成するため、
 * `control-plane-stack.ts` が escape hatch (`addPropertyOverride`) でこれらを上書きする。
 *
 * SMS は使わず TOTP 単独 (= SOFTWARE_TOKEN_MFA)。 国際 SMS の到達率不安定 + SNS コストを避ける。
 * tenant-template/identity-provider.ts (TenantAdmin 側、 既設) と同方針。
 *
 * password policy も同時に強化する。 SBT default (= 8 文字 / lower+upper+number+symbol) を
 * 12 文字に引き上げ、 SystemAdmin が SaaS 全体の権限を持つ前提に合わせる。
 */

export const SYSTEM_ADMIN_MFA_CONFIGURATION = "ON" as const;

export const SYSTEM_ADMIN_ENABLED_MFAS = ["SOFTWARE_TOKEN_MFA"] as const;

export const SYSTEM_ADMIN_PASSWORD_POLICY = {
  MinimumLength: 12,
  RequireLowercase: true,
  RequireNumbers: true,
  RequireSymbols: true,
  RequireUppercase: true,
  TemporaryPasswordValidityDays: 7,
} as const;
