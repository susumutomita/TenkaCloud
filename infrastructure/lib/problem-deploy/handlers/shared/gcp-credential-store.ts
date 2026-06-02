import { createSecureJsonStore, type SecureJsonStoreDeps } from "./secure-json-store.js";

/**
 * [ADR-027 / ADR-032 / Issue #1411] per-team GCP WIF deploy config store (SSM SecureString)。
 *
 * ADR-032: GCP は WIF AWS provider で **署名鍵レス** federate する (deploy Lambda の AWS identity が subject)。
 * よって保管するのは「秘密鍵」ではなく per-team の **federate 先 config** = WIF pool audience / 委譲先
 * service account email / project / location。 秘密ではないが、 per-team config を 1 箇所で扱うため Sakura /
 * Azure と同じ SecureString store ([[secure-json-store.ts]]) に相乗りする (= DRY、 path 規約も統一)。
 *
 * path 規約: `/{env}/tenants/{tenantId}/teams/{teamSlug}/gcp-credential`。 必須 field 欠落は fail-safe parse で undefined。
 */

/** per-team の GCP WIF deploy 設定。 鍵は持たず federate 先のみ。 */
export interface GcpDeployCredential {
  /** WIF pool provider の audience (例: `//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/tenkacloud/providers/aws`)。 */
  readonly wifAudience: string;
  /** 委譲先 service account の email。 */
  readonly serviceAccountEmail: string;
  /** deployment を置く GCP project ID。 */
  readonly projectId: string;
  /** Infra Manager の location (例 asia-northeast1)。 */
  readonly location: string;
}

export type GcpCredentialStoreDeps = SecureJsonStoreDeps;

export function buildGcpCredentialParameterName(
  env: string,
  tenantId: string,
  teamSlug: string,
): string {
  return `/${env}/tenants/${tenantId}/teams/${teamSlug}/gcp-credential`;
}

export function buildGcpCredentialParameterArnPattern(
  region: string,
  account: string,
  env: string,
): string {
  return `arn:aws:ssm:${region}:${account}:parameter/${env}/tenants/*/teams/*/gcp-credential`;
}

/** SSM から読んだ JSON を GcpDeployCredential に narrow (= 全 string field 必須、 欠落は undefined)。 */
function parseGcpCredential(raw: string | undefined): GcpDeployCredential | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const required = ["wifAudience", "serviceAccountEmail", "projectId", "location"] as const;
  for (const key of required) {
    if (typeof obj[key] !== "string" || (obj[key] as string).length === 0) return undefined;
  }
  return {
    wifAudience: obj.wifAudience as string,
    serviceAccountEmail: obj.serviceAccountEmail as string,
    projectId: obj.projectId as string,
    location: obj.location as string,
  };
}

const store = createSecureJsonStore<GcpDeployCredential>({
  buildName: buildGcpCredentialParameterName,
  parse: parseGcpCredential,
  serialize: (credential) => JSON.stringify(credential),
});

/** team の GCP WIF 設定を取得。 未登録 / 不正形式は undefined (= fail-closed)。 */
export function getGcpCredential(
  deps: GcpCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<GcpDeployCredential | undefined> {
  return store.get(deps, tenantId, teamSlug);
}

/** team の GCP WIF 設定を登録 / 上書き。 */
export function putGcpCredential(
  deps: GcpCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
  credential: GcpDeployCredential,
): Promise<void> {
  return store.put(deps, tenantId, teamSlug, credential);
}

/** team の GCP WIF 設定を削除 (= teardown)。 不在は no-op (idempotent)。 */
export function deleteGcpCredential(
  deps: GcpCredentialStoreDeps,
  tenantId: string,
  teamSlug: string,
): Promise<void> {
  return store.delete(deps, tenantId, teamSlug);
}
