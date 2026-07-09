import { getEnv } from "../../../helper-functions.js";
import type { CompetitorAccountItem } from "../competitor-accounts-handler/types.js";
import {
  composeRepositories,
  type Repositories,
  type RotationAgeMetricDatum,
} from "./repository.js";

/**
 * Phase 3.2 / Issue #603: ExternalId rotation 監査 Lambda。
 *
 * 1 日 1 回 EventBridge Scheduler から起動され、`CompetitorAccounts` を全件走査し、
 * 各 (tenantId, awsAccountId) の **rotation age (= 「最終 rotate からの経過日数」)** を
 * CloudWatch メトリクスとして emit する。`rotatedAt` が無い行 (= 未 rotate) は
 * `createdAt` を基準にする (= 初期 ExternalId が発行されてから何日経ったか)。
 *
 * 設計判断:
 *   - **SSM Parameter Store の 100-version cap で auto-drop が走るため、明示的な version
 *     cleanup Lambda は不要** (= TenkaCloud 規模 = 四半期に 1 回程度の rotate cadence なら
 *     100 version 上限に永遠に達しない)。代わりに「rotate していない tenant」を operator が
 *     可視化できる metric を emit する。
 *   - MVP 規模 (= tenant ~50 / account ~150) で 1 page で完了する想定。
 *     成長してきたら EventBridge bus 経由で per-tenant fan-out に置き換える。
 *   - 1 metric = 1 (tenantId, awsAccountId) dimension。operator が CloudWatch Alarm で
 *     "RotationAge > 90 days" を 1 ルールでカバーできる。
 *
 * Issue #1237: SDK の Command 構築は `repository.ts` に閉じ込める。本 index.ts は
 * 「環境変数 → repository 呼び出し → 結果の構造化ログ」のオーケストレーションに専念
 * し、`@aws-sdk/*` を直接 import しない (= `handler-no-direct-sdk-import` 不変条件)。
 *
 * [Issue #2442 / Phase C2] `CompetitorAccounts` の読み取りは repository seam
 * (`resolveCompetitorAccountsRepository`) 経由になり、`repository.ts` の
 * `forEachAccountPage` (= B3 の per-page callback パターン、`DeploymentsRepository
 * .forEachCompleteDeploymentPage` と同型) を1 度呼ぶだけで全ページを走査する
 * (= 旧 `cursor` 手動ループは廃止)。 backend 選択 (dynamodb/turso/sql) は本 handler から
 * 透過的。
 *
 * Metric namespace / dimension (= repository が保証する物理形):
 *   - Namespace: `TenkaCloud/CompetitorAccounts`
 *   - MetricName: `RotationAge`
 *   - Dimensions: `TenantId`, `AwsAccountId`, `Environment`
 *   - Unit: `None` (= 日数 raw)
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AuditDependencies {
  readonly repositories: Repositories;
  readonly environmentName: string;
  readonly now: () => number;
}

export function computeRotationAgeDays(
  item: Partial<CompetitorAccountItem>,
  nowMs: number,
): number {
  // `rotatedAt` が無い行は `createdAt` を基準にする (= 初期発行から何日経ったか)。
  // 両方無い場合 (= 不正データ) は 0 を返す (= 後段の alarm を誤発火させない安全側)。
  const reference = item.rotatedAt ?? item.createdAt;
  if (typeof reference !== "string" || reference.length === 0) return 0;
  const parsed = Date.parse(reference);
  if (Number.isNaN(parsed)) return 0;
  const ageMs = nowMs - parsed;
  if (ageMs <= 0) return 0;
  return Math.floor(ageMs / MS_PER_DAY);
}

export async function collectRotationAges(
  deps: AuditDependencies,
): Promise<RotationAgeMetricDatum[]> {
  const nowMs = deps.now();
  const datapoints: RotationAgeMetricDatum[] = [];
  await deps.repositories.competitorAccounts.forEachAccountPage(async (items) => {
    for (const item of items) {
      if (typeof item.tenantId !== "string" || typeof item.awsAccountId !== "string") continue;
      datapoints.push({
        tenantId: item.tenantId,
        awsAccountId: item.awsAccountId,
        ageDays: computeRotationAgeDays(item, nowMs),
      });
    }
  });
  return datapoints;
}

export async function emitRotationAgeMetrics(
  deps: AuditDependencies,
  datapoints: readonly RotationAgeMetricDatum[],
): Promise<void> {
  await deps.repositories.rotationAgeMetrics.putRotationAge({
    datapoints,
    environmentName: deps.environmentName,
    timestamp: new Date(deps.now()),
  });
}

export async function runAudit(deps: AuditDependencies): Promise<{ readonly count: number }> {
  const datapoints = await collectRotationAges(deps);
  await emitRotationAgeMetrics(deps, datapoints);
  return { count: datapoints.length };
}

export async function handler(): Promise<void> {
  // [Issue #2442 / Phase C2] pure SQL backend (turso|sql) では CompetitorAccounts table
  // 自体が synth されず env も配線されない — `getEnv` の fail-fast に委ねると invoke ごとに
  // Initialization Error になる。空文字 default に緩和し、dynamodb / mirror backend の
  // 誤設定は runtime resolver (`requireDdbAndTableName`) が fail loud に受ける
  // (= silent fallback にはならない、他の shared builder と同じ緩和)。
  const deps: AuditDependencies = {
    repositories: composeRepositories(process.env.COMPETITOR_ACCOUNTS_TABLE_NAME ?? ""),
    environmentName: getEnv("DEPLOY_ENVIRONMENT"),
    now: () => Date.now(),
  };
  const result = await runAudit(deps);
  console.log(
    JSON.stringify({
      event: "competitor-accounts.audit",
      datapointCount: result.count,
      environment: deps.environmentName,
    }),
  );
}
