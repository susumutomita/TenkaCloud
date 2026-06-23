import {
  CfnManagedLoginBranding,
  type CfnUserPoolDomain,
  type IUserPool,
  type UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

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
 * ink 色トークン / Summit ロゴの厳密な `settings` / `assets` は巨大 JSON Document であり、
 * AWS の定石が live `DescribeManagedLoginBrandingByClient`(ReturnMergedResources=true) を
 * 起点に編集 → 投入する deploy 反復前提 (#1990 cross-cutting constraint)。 本 Phase は
 * `useCognitoProvidedValues` で Cognito 既定値の valid な managed login を立ち上げる
 * (= 崩れていた classic からの確実な改善)。 brand トークン投入は後続フェーズで扱う。
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

  // (2) Managed login branding を attach。 厳密な settings/assets は live 反復前提のため
  // Cognito 既定値で valid な managed login を立てる。
  const branding = new CfnManagedLoginBranding(scope, "ControlPlaneManagedLoginBranding", {
    userPoolId: refs.userPool.userPoolId,
    clientId: refs.clientId,
    useCognitoProvidedValues: true,
  });
  // managed login の表示には domain (managedLoginVersion=2) が先に存在している必要があるため
  // 明示的に依存を張る (branding は userPoolId / clientId しか参照せず CFn が順序を推論できない)。
  branding.node.addDependency(refs.userPoolDomain);
  return branding;
}
