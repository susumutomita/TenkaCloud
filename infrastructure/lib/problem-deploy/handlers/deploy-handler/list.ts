import { COMPOSITE_RUNTIME_KIND } from "./composite-deployment.js";
import { buildCompositeDetail, type CompositeDetail } from "./composite-detail.js";
import type { DeploySharedResources } from "./deploy.js";
import { resolveDeploymentsRepository } from "./shared.js";
import type { DeploymentItem, DeploymentProvenance, DeploymentStatus } from "./types.js";

export interface DeploymentSummary {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  /**
   * Operator が deploy form で入力した内部 slug。CFn StackName の由来 (`namePrefix`)
   * になっていて、deploy 後は変更不可。Operator UI 上は「内部 slug」として表示する。
   */
  readonly teamName: string;
  /**
   * 競技者が portal `PATCH /portal/me` で設定した表示用チーム名。Operator UI 上は
   * 「表示名 (競技者選択)」として表示し、未設定なら undefined。
   */
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly buildId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  /**
   * チーム共有ログインキー (短命 bearer)。`getDeployment` 経路 (= caller が own tenantId
   * で TenantAdmin 認可済) では返す。`listDeployments` 経路では出さない (= 万が一
   * UI が一覧画面でも誤露出しないよう、複数行スコープでは引かない)。
   */
  readonly teamLoginKey?: string;
  /**
   * [#2073] Composite parent 行のときだけ付く target-level status view。GSI3 を
   * ordinal 順に引いた各 target の whitelisted summary (secret / role / credential
   * は含まない)。legacy single-provider 行には付かない (= byte 互換を保つ)。
   */
  readonly composite?: CompositeDetail;
  /**
   * [Problem Packs / Issue #2096] Pack provenance for a PACK-SOURCED deployment,
   * resolved from the event-pinned catalog snapshot (#2095). Present on the
   * detail (`getDeployment`) response only; the list summary never sets it and a
   * core deployment never carries it (= existing shape unchanged). Carries no
   * local path / source credential.
   */
  readonly provenance?: DeploymentProvenance;
}

export interface ListDeploymentsRequest {
  readonly tenantId: string;
  readonly problemId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListDeploymentsResponse {
  readonly items: readonly DeploymentSummary[];
  readonly nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * 一覧表示で安全に返せる minimal な shape。`teamLoginKey` のような短命 bearer は
 * 出さない (= 一覧画面で誤露出しない)。`dbPassword` 等の CFn Parameter も同様。
 * 新しい sensitive フィールドが増えたらここに追加する。
 */
export function toSummary(item: Partial<DeploymentItem>): DeploymentSummary {
  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    region: String(item.region ?? ""),
    teamName: String(item.teamName ?? ""),
    displayTeamName: typeof item.displayTeamName === "string" ? item.displayTeamName : undefined,
    namePrefix: String(item.namePrefix ?? ""),
    status: (item.status ?? "PENDING") as DeploymentStatus,
    stackId: item.stackId,
    buildId: item.buildId,
    stackOutputs: item.stackOutputs,
    failureReason: item.failureReason,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
  };
}

/**
 * 詳細画面 (`getDeployment`) 専用の shape。`toSummary` に加えて `teamLoginKey` を含める。
 * caller は own tenantId で TenantAdmin 認可済なので、operator が hand-off のため再取得
 * できる必要がある。一覧 (`toSummary`) には含めず、誤露出経路を限定する。
 */
export function toDetail(item: Partial<DeploymentItem>): DeploymentSummary {
  return {
    ...toSummary(item),
    teamLoginKey: typeof item.teamLoginKey === "string" ? item.teamLoginKey : undefined,
    // [#2096] Pack-sourced deployments only: surface the immutable provenance
    // resolved from the event-pinned snapshot. Core rows have no `provenance`
    // attribute, so the field is omitted and the response shape is unchanged.
    ...(item.provenance ? { provenance: item.provenance } : {}),
  };
}

/**
 * 指定 tenant の Deployment 一覧を新しい順に返す。`problemId` が指定されたら
 * GSI1 query 後に in-memory で絞り込む (テナント当たりの行数が小さい前提)。
 */
export async function listDeployments(
  shared: DeploySharedResources,
  request: ListDeploymentsRequest,
): Promise<ListDeploymentsResponse> {
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const repository = await resolveDeploymentsRepository(shared);
  const page = await repository.listByTenantPage(request.tenantId, {
    limit,
    cursor: request.cursor,
  });
  const raw = page.items as Partial<DeploymentItem>[];
  const filtered = request.problemId ? raw.filter((i) => i.problemId === request.problemId) : raw;
  const items = filtered.map(toSummary);
  return { items, nextCursor: page.nextCursor };
}

/**
 * 指定 jobId の Deployment 1 件を返す。`tenantId` が caller と一致しない行は
 * クロステナント漏洩防止のため `undefined` を返す (404 相当)。
 */
export async function getDeployment(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
): Promise<DeploymentSummary | undefined> {
  const deploymentsRepository = await resolveDeploymentsRepository(shared);
  const item = (await deploymentsRepository.getDeployment(jobId)) as
    | Partial<DeploymentItem>
    | undefined;
  if (!item) return undefined;
  if (item.tenantId !== tenantId) return undefined;
  const detail = toDetail(item);
  // [#2073] Composite parent 行のときだけ target-level status を付与する。
  // legacy single-provider 行は `isCompositeParentItem` が false なので素の detail
  // を返し、byte 互換を保つ。tenant 認可は上の `item.tenantId !== tenantId` で確定済。
  if ((item as { runtimeKind?: unknown }).runtimeKind === COMPOSITE_RUNTIME_KIND) {
    const composite = await buildCompositeDetail(shared, jobId);
    return { ...detail, composite };
  }
  return detail;
}
