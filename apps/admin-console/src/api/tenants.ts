import type { ApiClient } from "./client";

/**
 * Tenant tier。"platinum" を選ぶと provision-tenant.sh が `cdk deploy` で
 * per-tenant の TenantTemplateStack (silo Cognito + 専用 application-admin-console)
 * を立てる (silo モード)。それ以外は共有 pooled stack を使う。
 *
 * 用語ずれ防止: 旧 "premium" は #55 で "platinum" にリネームした。
 * provision-tenant.sh の `if [[ $TIER == "PLATINUM" ]]` (case-insensitive) と揃える。
 */
export type Tier = "basic" | "advanced" | "platinum";

export type TenantStatus = "In progress" | "Complete" | "Deleted" | string;

export interface Tenant {
  tenantId: string;
  tenantName: string;
  email: string;
  tier: Tier;
  brokerEntraProfileId?: string;
  tenantStatus: TenantStatus;
  isActive?: boolean;
  /**
   * provision-tenant.sh が cdk deploy 後に CFn output を JSON で詰めて DynamoDB に
   * 書き戻す文字列。SBT が tenant detail に保管する。
   * 例: `'{"userPoolId":"...","appClientId":"...","apiGatewayUrl":"...","applicationAdminConsoleUrl":"https://..."}'`
   */
  tenantConfig?: string;
  tenantPhone?: string;
  tenantAddress?: string;
  createdAt?: string;
}

/**
 * tenantConfig 文字列を parse して構造化する。形式不正なら全フィールド undefined。
 * provision-tenant.sh の jq 出力に依存する型。#57 で provisioning ログ deep link 用の
 * 4 フィールド (provisioningBuildId / provisioningProjectName / provisioningRegion /
 * provisioningAccountId) を追加。
 */
export interface ParsedTenantConfig {
  userPoolId?: string;
  appClientId?: string;
  apiGatewayUrl?: string;
  applicationAdminConsoleUrl?: string;
  provisioningBuildId?: string;
  provisioningProjectName?: string;
  provisioningRegion?: string;
  provisioningAccountId?: string;
  brokerEntraProfileId?: string;
  brokerEntraConfigParameter?: string;
}

export function parseTenantConfig(raw: string | undefined): ParsedTenantConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ParsedTenantConfig;
    return parsed;
  } catch {
    return {};
  }
}

/**
 * CodeBuild build の AWS Console deep link を組み立てる。
 * 例: https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/123456789012/projects/{project}/build/{project}%3A{uuid}/?region=ap-northeast-1
 *
 * 必須要素のいずれかが欠けていたら null を返す (admin-console 側はリンクを出さない)。
 * provisioningBuildId は "{projectName}:{uuid}" 形式を期待する (CodeBuild env CODEBUILD_BUILD_ID)。
 */
export function buildCodeBuildBuildUrl(parts: {
  buildId: string | undefined;
  projectName: string | undefined;
  region: string | undefined;
  accountId: string | undefined;
}): string | null {
  const { buildId, projectName, region, accountId } = parts;
  if (!buildId || !projectName || !region || !accountId) return null;
  if (
    buildId === "unknown" ||
    projectName === "unknown" ||
    region === "unknown" ||
    accountId === "unknown"
  ) {
    return null;
  }
  // CodeBuild build id ":" は URL では %3A
  const encodedBuildId = encodeURIComponent(buildId);
  return `https://${region}.console.aws.amazon.com/codesuite/codebuild/${accountId}/projects/${projectName}/build/${encodedBuildId}/?region=${region}`;
}

export interface CreateTenantRequest {
  tenantName: string;
  email: string;
  tier: Tier;
  brokerEntraProfileId?: string;
}

export async function listTenants(api: ApiClient): Promise<Tenant[]> {
  const res = await api.get<{ data?: Tenant[] } | Tenant[]>("tenants");
  return Array.isArray(res) ? res : (res.data ?? []);
}

/**
 * Tenant を新規作成する (SBT v0.3.9 準拠)。
 *
 * POST /tenants は:
 *   1. tenant-details DDB に put_item
 *   2. EventBridge に ONBOARDING event を発火 (bootstrap-template の BashJobRunner が起動)
 * までを tenant-management Lambda が一気通貫で行う。
 *
 * Request body は flat shape:
 *   { tenantName, email, tier, tenantStatus }
 * (ref の `client/Admin/src/app/views/tenants/create/create.component.ts` と同じ)
 */
export async function createTenant(api: ApiClient, req: CreateTenantRequest): Promise<Tenant> {
  const body = { ...req, tenantStatus: "In progress" as TenantStatus };
  const res = await api.post<{ data: Tenant }>("tenants", body);
  return res.data;
}

/**
 * Tenant を削除する。
 *
 * 現状 DELETE /tenants/{id} を叩くと isActive を false にするだけ (ref SBT 0.3.9 の挙動)。
 * テナント stack を実際に destroy するのは ref の cleanup.sh や deprovisioning 処理の話で、
 * admin-console からの単体削除は sbtaws_active フラグのみ。
 */
export async function deleteTenant(api: ApiClient, tenantId: string): Promise<void> {
  await api.del(`tenants/${encodeURIComponent(tenantId)}`);
}
