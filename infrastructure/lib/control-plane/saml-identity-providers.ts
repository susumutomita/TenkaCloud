import {
  type CfnUserPoolClient,
  ProviderAttribute,
  type UserPool,
  UserPoolIdentityProviderSaml,
  UserPoolIdentityProviderSamlMetadata,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

/**
 * Issue #1335 Phase 1: System Admin (Control Plane) 側 SAML SSO の attach module。
 *
 * Issue #1066 で SAML を一度撤廃したが、 enterprise tier (= CCoE / security 部門が買う層)
 * では IdP federation + audit が必須 (= ProtoShip でも実装済の pattern)。 MFA #1035 は
 * Cognito local auth の強化、 本 module は IdP 連携の追加であり目的が直交する。 SAML を
 * opt-in (env 未設定なら従来 MFA 強制 Cognito local auth のみ) で復活させる。
 *
 * 1 IdP = 1 entry。 同一 email ドメインに複数 IdP が並立できる (= 親会社 IdP + 子会社 IdP
 * のような構成)。 Cognito 標準の自動 HRD は domain → 1 provider 前提なので使わず、
 * admin-console 側 Login が email → 候補集合 を引いて `identity_provider` を明示指定する
 * (SP-initiated)。 IdP-initiated (Entra MyApps / Okta dashboard タイル経由) も併せて許可する。
 */
export interface SamlIdpConfig {
  /** Cognito provider 名。 3〜32 文字。 命名規約 `{scope}-{vendor}` (例 `corp-entra`)。 */
  readonly name: string;
  /** IdP の SAML federation metadata URL (HTTPS 必須)。 */
  readonly metadataUrl: string;
  /** この IdP で認証する email ドメイン (HRD 候補解決に使う、 1 件以上)。 */
  readonly emailDomains: readonly string[];
}

/** email ドメイン → 接続済み SAML provider 名の配列 (admin-console runtime-config の samlIdpDirectory)。 */
export type IdpDirectory = Record<string, string[]>;

/**
 * provider 命名は `{scope}-{vendor}` を推奨 (= `_` 区切りで prefix 衝突する名前は避ける)。
 * 詳細は saml-admin-allowlist.ts の PROVIDER_RE の説明を参照。
 */
const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;
const EMAIL_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

/**
 * `CONTROL_PLANE_SAML_IDPS` (JSON 配列) を parse・validate する。
 * 未設定 / 空なら空配列 (= SAML 無効 = Cognito local auth のみ、 現状維持)。
 * 不正な形は fail-loud で throw (silent fallback で誤設定を見逃さない)。
 *
 * `envVarName` はエラーメッセージに出す env 変数名。 Control Plane は既定の
 * `CONTROL_PLANE_SAML_IDPS`、 Phase 2 で application plane は `TENANT_SAML_IDPS` を渡す。
 */
export function parseSamlIdpConfig(
  raw: string | undefined,
  envVarName = "CONTROL_PLANE_SAML_IDPS",
): SamlIdpConfig[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${envVarName} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${envVarName} must be a JSON array of { name, metadataUrl, emailDomains }`);
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<SamlIdpConfig>;
    if (typeof e.name !== "string" || !PROVIDER_NAME_RE.test(e.name)) {
      throw new Error(
        `${envVarName}[${i}].name must match ${PROVIDER_NAME_RE} (3-32 chars): ${e.name}`,
      );
    }
    if (typeof e.metadataUrl !== "string" || !e.metadataUrl.startsWith("https://")) {
      throw new Error(`${envVarName}[${i}].metadataUrl must be an https URL: ${e.metadataUrl}`);
    }
    const domains = Array.isArray(e.emailDomains) ? e.emailDomains : [];
    if (domains.length === 0) {
      throw new Error(`${envVarName}[${i}].emailDomains must list at least one domain`);
    }
    return { name: e.name, metadataUrl: e.metadataUrl, emailDomains: domains };
  });
}

/**
 * 管理画面 UserPool に複数 SAML IdP を attach する (Issue #1335)。
 *
 * - `idpInitiated: true` で Entra MyApps / Okta dashboard タイル経由も許可
 * - persistent NameID を Cognito が federated username `{provider}_{subject}` の subject に使う
 *   (immutable ID、 saml-admin-allowlist の provider 束縛と合わせて成り立つ)
 * - 各 provider を client の SupportedIdentityProviders に追加 (COGNITO local auth は維持)
 * - 同一 domain 複数 IdP のため Cognito 自動 HRD `identifiers` は付けない (Login UI が
 *   `identity_provider` を明示指定する)
 *
 * 返り値: domain → [providerName] の HRD directory (admin-console runtime-config に流す)。
 * configs が空なら何もせず空 directory を返す (= SAML 無効、 既存 Cognito local auth 維持)。
 */
export function attachSamlIdentityProviders(
  scope: Construct,
  userPool: UserPool,
  cfnUserClient: CfnUserPoolClient,
  configs: readonly SamlIdpConfig[],
): IdpDirectory {
  const directory: IdpDirectory = {};
  const providerNames: string[] = [];

  for (const cfg of configs) {
    const provider = new UserPoolIdentityProviderSaml(scope, `Saml-${cfg.name}`, {
      userPool,
      name: cfg.name,
      metadata: UserPoolIdentityProviderSamlMetadata.url(cfg.metadataUrl),
      idpSignout: true,
      idpInitiated: true,
      attributeMapping: {
        email: ProviderAttribute.other(EMAIL_CLAIM),
      },
    });
    providerNames.push(cfg.name);
    for (const rawDomain of cfg.emailDomains) {
      const domain = rawDomain.trim().toLowerCase();
      if (!domain) continue;
      const existing = directory[domain] ?? [];
      existing.push(cfg.name);
      directory[domain] = existing;
    }
    // client の SupportedIdentityProviders 更新が provider 作成後になるよう依存を張る。
    cfnUserClient.node.addDependency(provider);
  }

  if (providerNames.length > 0) {
    // COGNITO local auth を維持しつつ SAML provider を追加する。
    cfnUserClient.addPropertyOverride("SupportedIdentityProviders", ["COGNITO", ...providerNames]);
  }

  return directory;
}
