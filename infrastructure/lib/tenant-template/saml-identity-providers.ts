/**
 * Issue #1340 Phase 2: per-tenant Application Plane 用 SAML IdP attach wrapper。
 *
 * Phase 1 (Control Plane / #1335) で `lib/control-plane/saml-identity-providers.ts` に
 * 純関数 `parseSamlIdpConfig` + CDK helper `attachSamlIdentityProviders` を実装済。 ロジック自体は
 * UserPool 構造体に依存しない (= scope / UserPool / CfnUserPoolClient を引数で受ける) ので
 * Application Plane でもそのまま再利用できる。 本 module は **import 元の意図** (= tenant-template
 * が自分の namespace から SAML を引いて attach する) を tenant-template/ 配下から読めるよう
 * re-export しつつ、 tenant 固有の env 変数名 (`TENANT_SAML_IDPS`) を default に持たせた helper を
 * 追加する。
 *
 * Phase 1 との違い:
 *   - 既定 envVarName を `TENANT_SAML_IDPS` にする (= ops debuggability)。
 *   - 適用先 UserPool は per-tenant の `IdentityProvider.tenantUserPool` (= silo / Lite mode)。
 *   - directory は per-tenant runtime-config.json に焼く (= tenant 越境はしない、 物理的 isolation)。
 *
 * Phase 1 の re-export ではなく **薄い wrapper** にしたのは、 将来 tenant 側だけに必要な
 * carve-out (例: pooled UserPool で SAML を NO-OP、 silo only enforcement 等) が出てきたとき、
 * Control Plane 側に逆流させないため。
 */

import type { CfnUserPoolClient, UserPool } from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import {
  attachSamlIdentityProviders as attachSamlIdentityProvidersBase,
  type IdpDirectory,
  parseSamlIdpConfig as parseSamlIdpConfigBase,
  type SamlIdpConfig,
} from "../control-plane/saml-identity-providers.js";

export type { IdpDirectory, SamlIdpConfig } from "../control-plane/saml-identity-providers.js";

/**
 * `TENANT_SAML_IDPS` (JSON 配列) を parse・validate する。 Phase 1 の汎用 parser を
 * tenant 既定 envVarName で呼び出すだけの薄い wrapper。 未設定 / 空なら空配列 (= SAML 無効、
 * 既存 Cognito local auth + MFA 強制のまま)。
 */
export function parseTenantSamlIdpConfig(raw: string | undefined): SamlIdpConfig[] {
  return parseSamlIdpConfigBase(raw, "TENANT_SAML_IDPS");
}

/**
 * Per-tenant UserPool に複数 SAML IdP を attach する thin wrapper。 ロジックは Phase 1 と
 * 同じ (= 自動 HRD `identifiers` を付けず、 SP-initiated で `identity_provider=` を明示)。
 * 返り値 directory は per-tenant runtime-config.json に焼かれる (= tenant A の Login 画面が
 * tenant B の directory を見ない、 物理的 isolation)。
 */
export function attachTenantSamlIdentityProviders(
  scope: Construct,
  userPool: UserPool,
  cfnUserClient: CfnUserPoolClient,
  configs: readonly SamlIdpConfig[],
): IdpDirectory {
  return attachSamlIdentityProvidersBase(scope, userPool, cfnUserClient, configs);
}
