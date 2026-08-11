import { createSecureJsonStore, type SecureJsonStoreDeps } from "./secure-json-store.js";

/**
 * [Issue #1410] per-team Azure deploy credential store (SSM SecureString)。
 *
 * Microsoft Entra ID は AWS-native の federation 経路を持たない (federated credential は OIDC
 * issuer のみ受付) ため、 AWS Lambda の deploy worker から鍵レスにするには platform-as-OIDC-issuer という
 * 重いサブシステムが要る。 deployable v1 ではこれを避け、 **per-team app registration の client secret を
 * SSM SecureString に保管** (Sakura stored-key と同型) し `client_credentials` grant で ARM token を
 * 得る。 long-lived secret なので Sakura 同等の補償 (per-team app + 最小 ARM ロール + SecureString のみ + rotation) を課す。
 *
 * path 規約: `/{env}/tenants/{tenantId}/teams/{teamSlug}/azure-credential`。 値は app registration の認証情報 +
 * deploy 先 (subscription / resourceGroup / location) をまとめた JSON。 plaintext で返さず都度 decrypt 取得。
 * SSM 機構は [[secure-json-store.ts]] を共有 (= Sakura store と DRY)。 `secrets-manager-forbidden` 準拠。
 */

/** per-team の Azure deploy 設定 (= app registration の認証情報 + Deployment Stack の置き場所)。 */
export interface AzureDeployCredential {
  /** Entra ID directory (tenant) GUID。 client_credentials の token endpoint path に使う。 */
  readonly azureTenantId: string;
  /** app registration の client ID。 */
  readonly clientId: string;
  /** app registration の client secret (= long-lived、 SecureString 保管)。 */
  readonly clientSecret: string;
  /** Deployment Stack を置く subscription GUID。 */
  readonly subscriptionId: string;
  /** Deployment Stack を置く resource group 名。 */
  readonly resourceGroup: string;
  /** ARM region (省略時は REST client の default)。 */
  readonly location?: string;
}

export type AzureCredentialStoreDeps = SecureJsonStoreDeps;

export function buildAzureCredentialParameterName(
  env: string,
  tenantId: string,
  teamSlug: string,
): string {
  return `/${env}/tenants/${tenantId}/teams/${teamSlug}/azure-credential`;
}

export function buildAzureCredentialParameterArnPattern(
  region: string,
  account: string,
  env: string,
): string {
  // IAM policy 用。 tenantId / teamSlug を `*` でワイルドカード化する。
  return `arn:aws:ssm:${region}:${account}:parameter/${env}/tenants/*/teams/*/azure-credential`;
}

/** SSM から読んだ JSON を AzureDeployCredential に narrow (= fail-safe parse、 必須 string field 欠落は undefined)。 */
function parseAzureCredential(raw: string | undefined): AzureDeployCredential | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const required = [
    "azureTenantId",
    "clientId",
    "clientSecret",
    "subscriptionId",
    "resourceGroup",
  ] as const;
  for (const key of required) {
    if (typeof obj[key] !== "string" || (obj[key] as string).length === 0) return undefined;
  }
  if (obj.location !== undefined && typeof obj.location !== "string") return undefined;
  return {
    azureTenantId: obj.azureTenantId as string,
    clientId: obj.clientId as string,
    clientSecret: obj.clientSecret as string,
    subscriptionId: obj.subscriptionId as string,
    resourceGroup: obj.resourceGroup as string,
    ...(typeof obj.location === "string" ? { location: obj.location } : {}),
  };
}

const store = createSecureJsonStore<AzureDeployCredential>({
  buildName: buildAzureCredentialParameterName,
  parse: parseAzureCredential,
  serialize: (credential) => JSON.stringify(credential),
});

/** team の Azure deploy 設定を取得。 未登録 / 不正形式は undefined (= fail-closed)。 */
export function getAzureCredential(
  deps: AzureCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<AzureDeployCredential | undefined> {
  return store.get(deps, tenantId, teamSlug);
}

/** team の Azure deploy 設定を登録 / 上書き (= register + rotation)。 */
export function putAzureCredential(
  deps: AzureCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
  credential: AzureDeployCredential,
): Promise<void> {
  return store.put(deps, tenantId, teamSlug, credential);
}

/** team の Azure deploy 設定を削除 (= revoke / teardown)。 不在は no-op (idempotent)。 */
export function deleteAzureCredential(
  deps: AzureCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<void> {
  return store.delete(deps, tenantId, teamSlug);
}
