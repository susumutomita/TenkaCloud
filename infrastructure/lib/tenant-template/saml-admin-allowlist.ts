/**
 * Issue #1340 Phase 2: per-tenant Application Plane 用 federated 管理者 allowlist wrapper。
 *
 * Phase 1 (`lib/control-plane/saml-admin-allowlist.ts`) と同じ provider 束縛 allowlist の
 * 仕組みを per-tenant UserPool (= silo / Lite mode の `IdentityProvider.tenantUserPool`) に
 * attach する thin wrapper。 fail-safe 契約 (= 空 = federated sign-in 全拒否) は Phase 1 と同一。
 *
 * tenant-template / Control Plane の分割 (= L2 vs L3 ではなく、 plane 境界):
 *   - Control Plane: SystemAdmin (= 全 tenant 横断、 plane の operator)
 *   - Application Plane (本 module): per-tenant の TenantAdmin (= L2、 application-admin-console)
 *
 * Participant Portal (= L3 / 競技参加者) は SAML を attach しない。 L3 は per-team login key
 * (= 短命な credential、 個人情報を抱えない設計) で運用されており、 enterprise IdP 連携の対象では
 * ない。 SAML SSO は L2 (= tenant 運営者) にだけ適用する (= ProtoShip docs の "L2/L3 separation"
 * の TenkaCloud 写経)。
 */

import type { UserPool } from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import {
  attachFederatedAdminAllowlist as attachFederatedAdminAllowlistBase,
  parseAdminAllowlist as parseAdminAllowlistBase,
} from "../control-plane/saml-admin-allowlist.js";

/**
 * `TENANT_SAML_ADMIN_ALLOWLIST` env を parse する thin wrapper。 Phase 1 の汎用 parser を
 * tenant 既定 envVarName で呼び出す。
 *   - 各エントリは `provider/email` 形式 (例 `corp-entra/admin@example.com`)。
 *   - 未設定 / 空なら空配列 = **federated sign-in 全拒否** (fail-safe)。
 *   - 不正な形は fail-loud で throw (silent fallback で誤設定を見逃さない)。
 */
export function parseTenantAdminAllowlist(raw: string | undefined): string[] {
  return parseAdminAllowlistBase(raw, "TENANT_SAML_ADMIN_ALLOWLIST");
}

/**
 * Per-tenant UserPool に federated 管理者 allowlist の Pre sign-up trigger を attach する。
 * SAML が有効な tenant でだけ呼ぶこと (= 未設定 tenant では federation 経路が無いので不要)。
 * `allowlist` が空でも attach する — 空配列 = federated sign-in 全拒否 (= SAML を誤って
 * 有効化したのに allowlist 未設定、 という構成事故で 「テナント外の federated user が
 * 全員 TenantAdmin」 になるのを防ぐ)。
 */
export function attachTenantFederatedAdminAllowlist(
  scope: Construct,
  userPool: UserPool,
  allowlist: readonly string[],
): void {
  attachFederatedAdminAllowlistBase(scope, userPool, allowlist);
}
