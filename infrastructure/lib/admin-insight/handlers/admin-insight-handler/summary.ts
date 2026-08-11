import type { DeploymentsQueryPort } from "../../../problem-deploy/control-data/deployments-repository.js";
import {
  type AdminInsightSharedResources,
  resolveDeploymentsRepository,
  resolveEventsRepository,
} from "./shared.js";

/**
 * 1 tenant 分の deploy / event 集計。Admin Insight API の正本 shape:
 *   {
 *     tenantId,
 *     activeDeploys,        // status ∈ {PENDING, IN_PROGRESS} の Deployments 件数
 *     completedDeploys,     // status === "COMPLETE" の Deployments 件数 (現在値)
 *     failedDeploys,        // status === "FAILED" の Deployments 件数
 *     everCompletedDeploys, // 一度でも COMPLETE に到達した累計 (撤去後も残る、#2946)
 *     totalEvents,          // Events GSI1 (TENANT#<id>) で得られる総件数
 *   }
 *
 * `name` / `tier` は SBT TenantDetails 管轄なので本 backend では返さない。frontend が
 * `listTenants` の結果 (= SBT ControlPlane API 由来) と tenantId で join する (Phase 1.A 設計)。
 * Phase 1.B 以降で SBT TenantDetails table の read を本 Lambda に同居させるなら本 shape を拡張する。
 */
export interface TenantSummary {
  readonly tenantId: string;
  readonly activeDeploys: number;
  /**
   * status === "COMPLETE" の件数。 active / failed だけでは「成功して稼働中の tenant」と
   * 「まだ何もしていない tenant」がどちらも 0 / 0 になり operator が区別できない (2026-08-08 の
   * SaaS モード動作確認で実際に誤認された) ため足した *現在値* の集計。
   *
   * **撤去済みは含まない**: teardown された deployment は DELETING / DELETED / EXPIRED /
   * AUTO_DELETED へ遷移するので、成功後に撤去すると再び 0 に戻る。 過去に成功したかどうかを
   * 累計で見せるには status 以外の marker が必要になる (FAILED 行も teardown 経路で DELETED に
   * なりうるので、現在の status から「かつて成功した」は復元できない)。
   */
  readonly completedDeploys: number;
  readonly failedDeploys: number;
  /**
   * [Issue #2946] 一度でも `COMPLETE` に到達した deployment の累計。撤去しても 0 に戻らない。
   *
   * 現在値の 3 列 (`activeDeploys` / `failedDeploys` / 現在 COMPLETE) は撤去すると揃って 0 に
   * なるため、「成功する deploy を何度も回している健全なテナント」と「一度も deploy して
   * いないテナント」が区別できなかった。この列はその区別のためだけにある。
   */
  readonly everCompletedDeploys: number;
  readonly totalEvents: number;
}

export interface TenantsSummaryResponse {
  readonly items: readonly TenantSummary[];
}

const ACTIVE_DEPLOY_STATUSES = ["PENDING", "IN_PROGRESS"];
const COMPLETED_DEPLOY_STATUSES = ["COMPLETE"];
const FAILED_DEPLOY_STATUSES = ["FAILED"];

/**
 * 1 tenant の deploy status カウント。
 *
 * [Issue #2441 / Phase B PR-6] repository seam (`countActiveByTenant`) 経由に置き換えた。
 * 従来は本 module 専用の raw GSI1 `QueryCommand` (`ProjectionExpression: "#s"`, 1 query で
 * active/failed 両方を集計) だったが、pure SQL backend (turso) では Deployments table
 * 自体が synth されず `shared.deploymentsTableName` が空文字になるため即死していた。
 * `countActiveByTenant` は deploy-quota.ts (#2441 Phase B1) で既に全 backend 実装済みの
 * 汎用カウントメソッドなので、それを active/completed/failed の 3 回呼ぶ形に寄せる。default
 * backend (dynamodb) は 1 回の full-item Query が `Select=COUNT` の 3 回の Query に分かれる差分のみ
 * (該当 API は operator の低頻度ダッシュボード呼び出しで、ホットパスではない)。
 *
 * 3 status の合計は tenant の全 deployment 数にはならない (APPROVAL_PENDING と teardown 系の
 * DELETING / DELETED / EXPIRED / AUTO_DELETED はどのカウントにも入らない)。 UI もそれらを
 * 合計として見せない。
 */
async function countTenantDeployments(
  shared: AdminInsightSharedResources,
  tenantId: string,
): Promise<{
  activeDeploys: number;
  completedDeploys: number;
  failedDeploys: number;
  everCompletedDeploys: number;
}> {
  const repository: DeploymentsQueryPort = await resolveDeploymentsRepository(shared);
  const [activeDeploys, completedDeploys, failedDeploys, everCompletedDeploys] = await Promise.all([
    repository.countActiveByTenant(tenantId, ACTIVE_DEPLOY_STATUSES),
    repository.countActiveByTenant(tenantId, COMPLETED_DEPLOY_STATUSES),
    repository.countActiveByTenant(tenantId, FAILED_DEPLOY_STATUSES),
    // [Issue #2946] marker ベースの累計。撤去後も残る唯一の列。
    repository.countEverCompletedByTenant(tenantId),
  ]);
  return { activeDeploys, completedDeploys, failedDeploys, everCompletedDeploys };
}

/**
 * 1 tenant の Events 総件数。 [#2438] repository seam
 * (`countEventsByTenant`) 経由。 default backend (dynamodb) では従来と byte 互換の
 * GSI1 (TENANT#<id>) Select=COUNT query を全 page drain する。
 */
async function countTenantEvents(
  shared: AdminInsightSharedResources,
  tenantId: string,
): Promise<number> {
  return (await resolveEventsRepository(shared)).countEventsByTenant(tenantId);
}

/**
 * 指定 tenant 一覧の deploy / event 集計を一括取得する。
 *
 * - tenant 単位の Query を `Promise.all` で並列発火する。Phase 1.A は MVP scale (~5 tenants ×
 *   ~50 deployments) なので各 tenant 並列 = 5 並列 ≒ 1 RCU/wave × 5 wave で済む。
 *   Phase 3 (dashboard) で tenant 数が伸びる場合は chunk 並列 / pre-aggregation で書き換える。
 * - 重複 tenantId は Set で除去 (= caller が double 送ってきても 1 回しか query しない)。
 * - 結果順は input 順を保つ (= frontend で join するときの安定性のため)。
 */
export async function summarizeTenants(
  shared: AdminInsightSharedResources,
  tenantIds: readonly string[],
): Promise<TenantsSummaryResponse> {
  // 重複除去 + 入力順を維持する uniqueIds。
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const id of tenantIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  const summaries = await Promise.all(
    uniqueIds.map(async (tenantId): Promise<TenantSummary> => {
      const [deploys, totalEvents] = await Promise.all([
        countTenantDeployments(shared, tenantId),
        countTenantEvents(shared, tenantId),
      ]);
      return {
        tenantId,
        activeDeploys: deploys.activeDeploys,
        completedDeploys: deploys.completedDeploys,
        failedDeploys: deploys.failedDeploys,
        everCompletedDeploys: deploys.everCompletedDeploys,
        totalEvents,
      };
    }),
  );
  return { items: summaries };
}
