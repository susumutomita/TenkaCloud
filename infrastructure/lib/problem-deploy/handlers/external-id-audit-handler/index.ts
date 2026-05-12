import {
  CloudWatchClient,
  type CloudWatchClientConfig,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import type { CompetitorAccountItem } from "../competitor-accounts-handler/types.js";

/**
 * Phase 3.2 / Issue #603: ExternalId rotation 監査 Lambda。
 *
 * 1 日 1 回 EventBridge Scheduler から起動され、`CompetitorAccounts` table を Scan し、
 * 各 (tenantId, awsAccountId) の **rotation age (= 「最終 rotate からの経過日数」)** を
 * CloudWatch メトリクスとして emit する。`rotatedAt` が無い行 (= 未 rotate) は
 * `createdAt` を基準にする (= 初期 ExternalId が発行されてから何日経ったか)。
 *
 * 設計判断:
 *   - **SSM Parameter Store の 100-version cap で auto-drop が走るため、明示的な version
 *     cleanup Lambda は不要** (= TenkaCloud 規模 = 四半期に 1 回程度の rotate cadence なら
 *     100 version 上限に永遠に達しない)。代わりに「rotate していない tenant」を operator が
 *     可視化できる metric を emit する。
 *   - DDB Scan は MVP 規模 (= tenant ~50 / account ~150) で 1 page で完了する想定。
 *     成長してきたら EventBridge bus 経由で per-tenant fan-out に置き換える。
 *   - 1 metric = 1 (tenantId, awsAccountId) dimension。operator が CloudWatch Alarm で
 *     "RotationAge > 90 days" を 1 ルールでカバーできる。
 *
 * Metric namespace / dimension:
 *   - Namespace: `TenkaCloud/CompetitorAccounts`
 *   - MetricName: `RotationAge`
 *   - Dimensions: `TenantId`, `AwsAccountId`, `Environment`
 *   - Unit: `None` (= 日数 raw)
 */

const METRIC_NAMESPACE = "TenkaCloud/CompetitorAccounts";
const METRIC_NAME = "RotationAge";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * PutMetricData は 1 call あたり 1000 datapoint まで。MVP 規模で 1000 を超えることは
 * 無いが、防御的に chunk 化する。
 */
const PUT_METRIC_BATCH_SIZE = 1000;

export interface AuditDependencies {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly cw: Pick<CloudWatchClient, "send">;
  readonly tableName: string;
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

interface AuditDatapoint {
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly ageDays: number;
}

export async function collectRotationAges(deps: AuditDependencies): Promise<AuditDatapoint[]> {
  const nowMs = deps.now();
  const datapoints: AuditDatapoint[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        ProjectionExpression: "tenantId, awsAccountId, rotatedAt, createdAt",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Partial<CompetitorAccountItem>[];
    for (const item of items) {
      if (typeof item.tenantId !== "string" || typeof item.awsAccountId !== "string") continue;
      datapoints.push({
        tenantId: item.tenantId,
        awsAccountId: item.awsAccountId,
        ageDays: computeRotationAgeDays(item, nowMs),
      });
    }
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return datapoints;
}

export async function emitRotationAgeMetrics(
  deps: AuditDependencies,
  datapoints: readonly AuditDatapoint[],
): Promise<void> {
  if (datapoints.length === 0) return;
  const timestamp = new Date(deps.now());
  for (let i = 0; i < datapoints.length; i += PUT_METRIC_BATCH_SIZE) {
    const slice = datapoints.slice(i, i + PUT_METRIC_BATCH_SIZE);
    await deps.cw.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: slice.map((d) => ({
          MetricName: METRIC_NAME,
          Value: d.ageDays,
          Unit: "None",
          Timestamp: timestamp,
          Dimensions: [
            { Name: "TenantId", Value: d.tenantId },
            { Name: "AwsAccountId", Value: d.awsAccountId },
            { Name: "Environment", Value: deps.environmentName },
          ],
        })),
      }),
    );
  }
}

export async function runAudit(deps: AuditDependencies): Promise<{ readonly count: number }> {
  const datapoints = await collectRotationAges(deps);
  await emitRotationAgeMetrics(deps, datapoints);
  return { count: datapoints.length };
}

// Lambda module-scope client (warm invoke で reuse、cold start 軽減)。
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw = new CloudWatchClient({} satisfies CloudWatchClientConfig);

export async function handler(): Promise<void> {
  const deps: AuditDependencies = {
    ddb,
    cw,
    tableName: getEnv("COMPETITOR_ACCOUNTS_TABLE_NAME"),
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
