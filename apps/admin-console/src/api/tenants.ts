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

/**
 * Tenant の provisioning 状態。provision-tenant.sh / deprovision-tenant.sh が
 * 実際に書き込む文字列リテラルを正本とする:
 *   - "In progress" — SBT が POST /tenant-registrations で初期値として書く
 *   - "Complete"   — provision-tenant.sh が ProvisioningScriptJob へ export
 *   - "Failed"     — ProvisioningScriptJob が exit non-zero のとき (SBT 内蔵)
 *   - "Deleted"    — deprovision-tenant.sh:136 で export
 * 比較は大文字 / 小文字非依存 (SBT が経路によって case を変えるため安全側に倒す)。
 */
export type TenantStatus = "In progress" | "Complete" | "Failed" | "Deleted" | string;

/**
 * Cloudscape Badge / StatusIndicator で使う色名 (BadgeProps["color"] と互換)。
 * Badge component に直接渡せるよう値だけを返す軽量関数として export し、UI 層から
 * 切り離して unit test 可能にする。
 */
export type StatusBadgeColor = "green" | "blue" | "red" | "grey";

/**
 * `tenantStatus` 文字列 → Badge 色のマッピング。`provision-tenant.sh` が
 * `tenantStatus="Complete"`、`deprovision-tenant.sh` が `tenantStatus="Deleted"`、
 * SBT 初期化が `"In progress"`、ProvisioningScriptJob 失敗時が `"Failed"` を書くので
 * それを正本に色を決める。SBT 経路によって case が揺れるため case-insensitive。
 *
 * 既知でない値 (空 / undefined / 想定外文字列) は grey にフォールバックする
 * (= 状態不明であることを UI 上で示すが、エラー扱いはしない)。
 */
export function tenantStatusBadgeColor(tenantStatus: string | undefined): StatusBadgeColor {
  switch ((tenantStatus ?? "").toLowerCase()) {
    case "complete":
      return "green";
    case "in progress":
      return "blue";
    case "failed":
    case "suspended":
      return "red";
    case "deleted":
    case "deprovisioned":
      return "grey";
    default:
      return "grey";
  }
}

/**
 * Tier → Badge 色のマッピング。silo 専用 stack を立てる "platinum" を最も目立つ色
 * (green) に、pooled stack 共有の "basic" / "advanced" は控えめにする。
 *
 * `provision-tenant.sh` の `if [[ $TIER == "PLATINUM" ]]` 大文字比較に合わせて
 * case-insensitive で判定する。未知の tier は grey フォールバック。
 */
export function tierBadgeColor(tier: string | undefined): StatusBadgeColor {
  switch ((tier ?? "").toLowerCase()) {
    case "platinum":
      return "green";
    case "advanced":
      return "blue";
    case "basic":
      return "grey";
    default:
      return "grey";
  }
}

export interface Tenant {
  tenantId: string;
  /**
   * SBT v0.9.5 の lifecycle 操作を識別する ID。旧 tenant は backfill 完了まで未設定のため、
   * list では optional のまま保持し、delete は欠落時に fail closed する。
   */
  tenantRegistrationId?: string;
  tenantName: string;
  email: string;
  tier: Tier;
  tenantStatus: TenantStatus;
  isActive?: boolean;
  sbtaws_active?: boolean;
  isSuspended?: boolean;
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

export function isTenantSuspended(tenant: Pick<Tenant, "isSuspended">): boolean {
  return tenant.isSuspended === true;
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
}

export async function listTenants(api: ApiClient): Promise<Tenant[]> {
  const tenants: Tenant[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const path = `tenants?limit=100${
      nextToken ? `&next_token=${encodeURIComponent(nextToken)}` : ""
    }`;
    const res = await api.get<{ data?: Tenant[]; next_token?: string } | Tenant[]>(path);
    if (Array.isArray(res)) return res.map(normalizeTenant);
    tenants.push(...(res.data ?? []).map(normalizeTenant));
    nextToken = res.next_token;
    if (nextToken) {
      if (seenTokens.has(nextToken)) {
        throw new Error(`SBT returned repeated pagination token ${nextToken}`);
      }
      seenTokens.add(nextToken);
    }
  } while (nextToken);
  return tenants;
}

function normalizeTenant(tenant: Tenant): Tenant {
  return {
    ...tenant,
    isActive:
      typeof tenant.sbtaws_active === "boolean"
        ? tenant.sbtaws_active
        : typeof tenant.isActive === "boolean"
          ? tenant.isActive
          : undefined,
  };
}

/**
 * Tenant を新規作成する (SBT v0.9.5 tenant-registration contract)。
 *
 * POST /tenant-registrations が registration row と tenant row を作り、
 * `sbt_aws_onboardingRequest` を発火する。tenant と registration の更新先を SBT が
 * 区別できるよう request body は 2 つの data object に分ける。
 */
export async function createTenant(api: ApiClient, req: CreateTenantRequest): Promise<Tenant> {
  const tenantStatus: TenantStatus = "In progress";
  const body = {
    tenantData: { ...req, tenantStatus },
    tenantRegistrationData: { registrationStatus: "In progress" },
  };
  const res = await api.post<{
    data: { tenantId: string; tenantRegistrationId: string; message?: string };
  }>("tenant-registrations", body);
  const tenantId = res.data.tenantId?.trim();
  const tenantRegistrationId = res.data.tenantRegistrationId?.trim();
  if (!tenantId || !tenantRegistrationId) {
    throw new Error(
      "SBT tenant-registration response must include tenantId and tenantRegistrationId",
    );
  }
  return {
    ...req,
    tenantStatus,
    tenantId,
    tenantRegistrationId,
    isActive: true,
    sbtaws_active: true,
  };
}

/**
 * Tenant を削除する。
 *
 * SBT v0.9.5 は tenantRegistrationId を lifecycle job identifier として使う。
 * legacy tenant を tenantId で旧 endpoint に送る fallback は deprovisioning を起動しないため
 * 禁止し、backfill が未実施なら明示エラーにする。
 */
export async function deleteTenant(
  api: ApiClient,
  tenant: Pick<Tenant, "tenantId" | "tenantRegistrationId">,
): Promise<void> {
  const tenantRegistrationId = tenant.tenantRegistrationId?.trim();
  if (!tenantRegistrationId) {
    throw new Error(
      `Tenant ${tenant.tenantId} has no tenantRegistrationId; run the SBT 0.9.5 tenant-registration backfill before deprovisioning`,
    );
  }
  await api.del(`tenant-registrations/${encodeURIComponent(tenantRegistrationId)}`);
}
