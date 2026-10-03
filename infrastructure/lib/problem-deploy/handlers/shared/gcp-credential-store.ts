import { createSecureJsonStore, type SecureJsonStoreDeps } from "./secure-json-store.js";

/**
 * [Issue #1411] per-team GCP WIF deploy config store (SSM SecureString)。
 *
 * GCP は WIF AWS provider で **署名鍵レス** federate する (deploy Lambda の AWS identity が subject)。
 * よって保管するのは「秘密鍵」ではなく per-team の **federate 先 config** = WIF pool audience / 委譲先
 * service account email / project / location。 秘密ではないが、 per-team config を 1 箇所で扱うため Sakura /
 * Azure と同じ SecureString store ([[secure-json-store.ts]]) に相乗りする (= DRY、 path 規約も統一)。
 *
 * path 規約: `/{env}/tenants/{tenantId}/teams/{teamSlug}/gcp-credential`。 必須 field 欠落は fail-safe parse で undefined。
 *
 * [Issue #2745] `artifactBucket` は任意 field — Terraform blueprint zip を upload する team 所有の GCS
 * bucket 名。 秘密ではない (bucket 名) が per-team config の一部なので同じ JSON に相乗りする。 既存登録済み
 * credential (本 field 未登録) は引き続き parse に成功する (= 後方互換、 破壊的変更ではない) が、
 * gcp/infra-manager 問題を deploy しようとすると `gcp-blueprint-materializer.ts` が fail-closed で
 * 「artifactBucket を登録してください」と loud に throw する。
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
  /**
   * [Issue #2745] Terraform blueprint zip の upload 先 GCS bucket 名 (team 所有、 platform infra ではない)。
   * 未登録は gcp/infra-manager 問題の materialize 時に fail-closed (「register artifactBucket」)。
   */
  readonly artifactBucket?: string;
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

/**
 * SSM から読んだ JSON を GcpDeployCredential に narrow (= 4 つの必須 string field + 任意
 * `artifactBucket`、 いずれかの必須 field 欠落 / 型不一致は undefined、 `artifactBucket` は
 * 非 string / 空文字なら黙って落とす (= 未登録扱い、 型不一致でも parse 全体は失敗させない)。
 */
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
  const artifactBucket =
    typeof obj.artifactBucket === "string" && obj.artifactBucket.length > 0
      ? obj.artifactBucket
      : undefined;
  return {
    wifAudience: obj.wifAudience as string,
    serviceAccountEmail: obj.serviceAccountEmail as string,
    projectId: obj.projectId as string,
    location: obj.location as string,
    ...(artifactBucket ? { artifactBucket } : {}),
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
