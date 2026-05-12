import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AdminInsightSharedResources } from "./shared.js";

/**
 * 1 tenant 分の deploy / event 集計。ADR-011 Phase 1 API の正本 shape:
 *   {
 *     tenantId,
 *     activeDeploys,   // status ∈ {PENDING, IN_PROGRESS} の Deployments 件数
 *     failedDeploys,   // status === "FAILED" の Deployments 件数
 *     totalEvents,     // Events GSI1 (TENANT#<id>) で得られる総件数
 *   }
 *
 * `name` / `tier` は SBT TenantDetails 管轄なので本 backend では返さない。frontend が
 * `listTenants` の結果 (= SBT ControlPlane API 由来) と tenantId で join する (Phase 1.A 設計)。
 * Phase 1.B 以降で SBT TenantDetails table の read を本 Lambda に同居させるなら本 shape を拡張する。
 */
export interface TenantSummary {
  readonly tenantId: string;
  readonly activeDeploys: number;
  readonly failedDeploys: number;
  readonly totalEvents: number;
}

export interface TenantsSummaryResponse {
  readonly items: readonly TenantSummary[];
}

const ACTIVE_DEPLOY_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);

/**
 * 1 tenant の Deployments GSI1 を全 page 読みつつ status カウントを返す。
 *
 * GSI1PK = `TENANT#<tenantId>`、Sort key は createdAt 降順で良いが、本集計では順序は問わない
 * のでデフォルト (= 昇順 / `ScanIndexForward: true`) のまま使う。`ProjectionExpression` で
 * `status` のみ取り、payload を最小化する (= Free Tier RCU 圧迫を避ける)。
 *
 * Phase 1.A は tenant 数 ~5 × deployments/tenant ~50 ≒ 250 行で十分。Phase 3 (dashboard)
 * では tenant 数が伸びてくるので、本 query ロジックを置き換える (= reverse-aggregated 行を
 * 別 GSI / pre-aggregation table に置く設計に切替)。
 */
async function countTenantDeployments(
  shared: AdminInsightSharedResources,
  tenantId: string,
): Promise<{ activeDeploys: number; failedDeploys: number }> {
  let activeDeploys = 0;
  let failedDeploys = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const out = await shared.ddb.send(
      new QueryCommand({
        TableName: shared.deploymentsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        // `status` は DDB reserved word なので ExpressionAttributeNames で alias する。
        ProjectionExpression: "#s",
        ExpressionAttributeNames: { "#s": "status" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of out.Items ?? []) {
      const status = String((item as { status?: unknown }).status ?? "");
      if (ACTIVE_DEPLOY_STATUSES.has(status)) activeDeploys += 1;
      else if (status === "FAILED") failedDeploys += 1;
    }
    lastEvaluatedKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return { activeDeploys, failedDeploys };
}

/**
 * 1 tenant の Events 総件数。Events GSI1 (TENANT#<id>) を Select=COUNT で叩く。
 * AggregationCount で page 跨ぎを安全に集計する。
 */
async function countTenantEvents(
  shared: AdminInsightSharedResources,
  tenantId: string,
): Promise<number> {
  let total = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const out = await shared.ddb.send(
      new QueryCommand({
        TableName: shared.eventsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        // payload 不要 (COUNT のみで良い)。
        Select: "COUNT",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    total += out.Count ?? 0;
    lastEvaluatedKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return total;
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
        failedDeploys: deploys.failedDeploys,
        totalEvents,
      };
    }),
  );
  return { items: summaries };
}
