import {
  CfnManagedLoginBranding,
  type CfnUserPoolDomain,
  type IUserPool,
  type UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import {
  buildInkManagedLoginAssets,
  buildInkManagedLoginSettings,
} from "../shared/managed-login-branding.js";

/**
 * Issue #1992 (Phase 2 of #1990 epic): Control Plane (SBT) の System Admin ログインを
 * classic Hosted UI から **Managed login (v2)** へ移行する attach module。
 *
 * Application Plane 側 (#1991, tenant-template/identity-provider.ts) と同じ方針:
 * classic Hosted UI の CSS customization は `*-customizable` allowlist の制約で
 * design import を再現できず deploy 後に画面が崩れた (#1987 / #1989)。 Managed login
 * (ブランディングデザイナー世代) は rounded corner / gradient / custom font / ロゴ画像を
 * コード指定できる。
 *
 * SBT の `CognitoAuth` が払い出した UserPool / UserPoolDomain / client を受け取り、
 * (1) domain を `ManagedLoginVersion=2` に escape hatch で上書き、 (2) `CfnManagedLoginBranding`
 * を attach する。 Control Plane 側は classic の `UserPoolUICustomizationAttachment` を
 * 持たないため撤去は不要 (= 純粋に additive)。
 *
 * ブランディングは ink テーマ + Summit ロゴ。 厳密な settings は巨大 JSON Document だが、
 * Cognito は **指定しなかったトークンを既定値のまま保持する** (= partial settings は valid)
 * ため、 ink ブランドトークンだけを上書きする最小 settings を `shared/managed-login-branding.ts`
 * から取得して投入する (両 plane で共有)。 `settings`/`assets` を渡す場合 `useCognitoProvidedValues`
 * は **排他** なので省略する。 pixel 一致は Cognito console の branding editor で微調整する前提。
 *
 * SBT の構築ツリーに依存せずユニットテストできるよう pure な attach 関数として切り出す
 * (= SAML attach module `saml-identity-providers.ts` と同じ設計)。
 */
export interface ControlPlaneManagedLoginRefs {
  /** SBT `CognitoAuth.userPool` (= System Admin が登録される UserPool)。 */
  readonly userPool: IUserPool;
  /** SBT 内蔵 `UserPoolDomain` (= `cognitoAuth.node.findChild("UserPoolDomain")`)。 */
  readonly userPoolDomain: UserPoolDomain;
  /** SBT `CognitoAuth.userClientId` (= admin-console が OAuth Code+PKCE で使う client)。 */
  readonly clientId: string;
}

export function applyControlPlaneManagedLogin(
  scope: Construct,
  refs: ControlPlaneManagedLoginRefs,
): CfnManagedLoginBranding {
  // (1) domain を Managed login (v2) へ。 SBT 内蔵 UserPoolDomain は escape hatch で上書きする。
  const cfnDomain = refs.userPoolDomain.node.defaultChild as CfnUserPoolDomain;
  cfnDomain.addPropertyOverride("ManagedLoginVersion", 2);

  // (2) Managed login branding を attach。 ink テーマの partial settings + Summit ロゴを
  // 投入する (Cognito 既定値に merge される)。 settings/assets を渡すので
  // useCognitoProvidedValues は省略する (排他)。
  const branding = new CfnManagedLoginBranding(scope, "ControlPlaneManagedLoginBranding", {
    userPoolId: refs.userPool.userPoolId,
    clientId: refs.clientId,
    settings: buildInkManagedLoginSettings(),
    assets: buildInkManagedLoginAssets(),
  });
  // managed login の表示には domain (managedLoginVersion=2) が先に存在している必要があるため
  // 明示的に依存を張る (branding は userPoolId / clientId しか参照せず CFn が順序を推論できない)。
  branding.node.addDependency(refs.userPoolDomain);
  return branding;
}
