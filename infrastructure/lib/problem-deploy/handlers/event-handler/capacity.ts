import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { EVENT_CAPACITY_CEILING } from "../../event-capacity-constants.js";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 backend。
 *
 * 運営が event 管理画面 (application-admin-console) で「消費 / プロビジョン / throttle」を
 * 見ながら SSM runbook (Slice 1) でキャパを上げ下げするための read-only 集計。
 *
 *  - DescribeTable: 現行プロビジョン (base + GSI)
 *  - CloudWatch GetMetricData: 直近 window の消費 (avg / peak per-sec) + throttle 件数
 *    (base は Consumed / Throttle の 4 系列、GSI は throttle 2 系列 — runbook が base と GSI を
 *    同値に揃えるため、GSI 側は「throttle が出ているか」だけが意思決定に効く)
 *
 * ADR-014 / AGENTS.md の方針どおり frontend は polling でこの route を叩く (SSE/WS なし)。
 */

/** event-hot テーブルの論理 role (UI 表示ラベル + response の安定キー)。 */
export type CapacityTableRole =
  | "deployments"
  | "events"
  | "teams"
  | "problemEndpoints"
  | "disruptions";

export interface CapacityGsiSummary {
  readonly indexName: string;
  readonly provisionedRead: number;
  readonly provisionedWrite: number;
  /** 直近 window の GSI ReadThrottleEvents 合計。 */
  readonly readThrottleEvents: number;
  /** 直近 window の GSI WriteThrottleEvents 合計。 */
  readonly writeThrottleEvents: number;
}

export interface CapacityTableSummary {
  readonly role: CapacityTableRole;
  readonly tableName: string;
  readonly provisionedRead: number;
  readonly provisionedWrite: number;
  readonly gsis: readonly CapacityGsiSummary[];
  /** 直近 window の平均消費 RCU/sec (ConsumedReadCapacityUnits Sum ÷ window 秒)。 */
  readonly consumedReadPerSecAvg: number;
  readonly consumedWritePerSecAvg: number;
  /** 直近 window で最も熱かった 1 分間の消費 RCU/sec (per-minute Sum の最大 ÷ 60)。 */
  readonly consumedReadPerSecPeak: number;
  readonly consumedWritePerSecPeak: number;
  /** 直近 window の base table ReadThrottleEvents 合計。 */
  readonly readThrottleEvents: number;
  readonly writeThrottleEvents: number;
}

export interface CapacityOverview {
  readonly windowMinutes: number;
  /** runbook の構造的ハード上限 (UI が「上限 200」を表示するための echo)。 */
  readonly ceiling: number;
  /** Slice 1 の SSM Automation document 名。未配線 stack では null。 */
  readonly runbookDocumentName: string | null;
  readonly generatedAt: string;
  readonly tables: readonly CapacityTableSummary[];
}

export const CAPACITY_WINDOW_DEFAULT_MINUTES = 30;

/** `GET /admin/capacity` の query。windowMinutes は 5〜180 分 (CloudWatch 1 分粒度の実用範囲)。 */
export const CapacityQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(180).default(CAPACITY_WINDOW_DEFAULT_MINUTES),
});

/**
 * 監視対象 env が未配線 (= 旧 deploy chain) のときに投げる。route は 503 に変換する
 * (audit-log read の `audit_log_unconfigured` と同じ「fail loudly」パターン)。
 */
export class CapacityUnconfiguredError extends Error {
  constructor(missingEnv: string) {
    super(`capacity monitoring is not wired: missing env ${missingEnv}`);
    this.name = "CapacityUnconfiguredError";
  }
}

interface EventHotTable {
  readonly role: CapacityTableRole;
  readonly tableName: string;
}

/** role → env 名の対応 (EventApiLambda が注入する)。 */
const EVENT_HOT_TABLE_ENVS: readonly (readonly [CapacityTableRole, string])[] = [
  ["deployments", "DEPLOYMENTS_TABLE_NAME"],
  ["events", "EVENTS_TABLE_NAME"],
  ["teams", "TEAMS_TABLE_NAME"],
  ["problemEndpoints", "PROBLEM_ENDPOINTS_TABLE_NAME"],
  ["disruptions", "DISRUPTIONS_TABLE_NAME"],
];

/**
 * env から event-hot 5 テーブルを解決する。1 つでも未配線なら
 * {@link CapacityUnconfiguredError} — 部分的な監視ビューを黙って返さない (silent fallback 禁止)。
 */
export function resolveEventHotTables(): readonly EventHotTable[] {
  return EVENT_HOT_TABLE_ENVS.map(([role, envName]) => {
    const tableName = process.env[envName] ?? "";
    if (tableName.length === 0) throw new CapacityUnconfiguredError(envName);
    return { role, tableName };
  });
}

export interface CapacityClients {
  readonly ddb: Pick<DynamoDBClient, "send">;
  readonly cw: Pick<CloudWatchClient, "send">;
}

/**
 * Module-scope の production clients (warm invoke で socket pool を再利用する
 * `external-id-audit-handler/repository.ts` と同じ pattern)。tests は
 * {@link getCapacityOverview} の `clients` 引数で fake を注入する。
 */
let cachedClients: CapacityClients | undefined;
export function defaultCapacityClients(): CapacityClients {
  if (!cachedClients) {
    cachedClients = { ddb: new DynamoDBClient({}), cw: new CloudWatchClient({}) };
  }
  return cachedClients;
}

const DDB_METRIC_NAMESPACE = "AWS/DynamoDB";
const PERIOD_SECONDS = 60;

interface MetricSeriesIds {
  readonly consumedRead: string;
  readonly consumedWrite: string;
  readonly readThrottle: string;
  readonly writeThrottle: string;
  readonly gsiThrottles: readonly { indexName: string; read: string; write: string }[];
}

function metricQuery(
  id: string,
  metricName: string,
  dimensions: readonly { Name: string; Value: string }[],
): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: DDB_METRIC_NAMESPACE,
        MetricName: metricName,
        Dimensions: [...dimensions],
      },
      Period: PERIOD_SECONDS,
      Stat: "Sum",
    },
    ReturnData: true,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function max(values: readonly number[]): number {
  return values.reduce((acc, v) => (v > acc ? v : acc), 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** DescribeTable 結果から provisioned RCU/WCU を取り出す (on-demand は本 platform に存在しない)。 */
function provisionedOf(throughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number }): {
  read: number;
  write: number;
} {
  return {
    read: throughput?.ReadCapacityUnits ?? 0,
    write: throughput?.WriteCapacityUnits ?? 0,
  };
}

export async function getCapacityOverview(opts: {
  readonly windowMinutes: number;
  /** テスト注入用。省略時は現在時刻。 */
  readonly now?: Date;
  /** テスト注入用。省略時は module-scope の production clients。 */
  readonly clients?: CapacityClients;
}): Promise<CapacityOverview> {
  const tables = resolveEventHotTables();
  const clients = opts.clients ?? defaultCapacityClients();
  const now = opts.now ?? new Date();

  const descriptions = await Promise.all(
    tables.map(async (t) => {
      const out = await clients.ddb.send(new DescribeTableCommand({ TableName: t.tableName }));
      return (out as { Table?: TableDescription }).Table ?? {};
    }),
  );

  // Metric query は DescribeTable の GSI 一覧に依存するため 2 段で組む。
  const seriesIds: MetricSeriesIds[] = [];
  const queries: MetricDataQuery[] = [];
  tables.forEach((t, i) => {
    const dim = [{ Name: "TableName", Value: t.tableName }];
    const ids: MetricSeriesIds = {
      consumedRead: `t${i}cr`,
      consumedWrite: `t${i}cw`,
      readThrottle: `t${i}rt`,
      writeThrottle: `t${i}wt`,
      gsiThrottles: (descriptions[i]?.GlobalSecondaryIndexes ?? []).map((gsi, j) => ({
        indexName: gsi.IndexName ?? `gsi${j}`,
        read: `t${i}g${j}rt`,
        write: `t${i}g${j}wt`,
      })),
    };
    seriesIds.push(ids);
    queries.push(
      metricQuery(ids.consumedRead, "ConsumedReadCapacityUnits", dim),
      metricQuery(ids.consumedWrite, "ConsumedWriteCapacityUnits", dim),
      metricQuery(ids.readThrottle, "ReadThrottleEvents", dim),
      metricQuery(ids.writeThrottle, "WriteThrottleEvents", dim),
    );
    for (const gsi of ids.gsiThrottles) {
      const gsiDim = [...dim, { Name: "GlobalSecondaryIndexName", Value: gsi.indexName }];
      queries.push(
        metricQuery(gsi.read, "ReadThrottleEvents", gsiDim),
        metricQuery(gsi.write, "WriteThrottleEvents", gsiDim),
      );
    }
  });

  const metricData = await clients.cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(now.getTime() - opts.windowMinutes * 60_000),
      EndTime: now,
      MetricDataQueries: queries,
    }),
  );
  const valuesById = new Map<string, readonly number[]>();
  for (const result of (metricData as { MetricDataResults?: { Id?: string; Values?: number[] }[] })
    .MetricDataResults ?? []) {
    if (result.Id) valuesById.set(result.Id, result.Values ?? []);
  }
  const seriesOf = (id: string): readonly number[] => valuesById.get(id) ?? [];

  const windowSeconds = opts.windowMinutes * 60;
  return {
    windowMinutes: opts.windowMinutes,
    ceiling: EVENT_CAPACITY_CEILING,
    runbookDocumentName:
      (process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME ?? "").length > 0
        ? (process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME as string)
        : null,
    generatedAt: now.toISOString(),
    tables: tables.map((t, i): CapacityTableSummary => {
      const desc = descriptions[i] ?? {};
      const base = provisionedOf(desc.ProvisionedThroughput);
      const ids = seriesIds[i] as MetricSeriesIds;
      const gsiThrottleById = new Map(ids.gsiThrottles.map((g) => [g.indexName, g]));
      return {
        role: t.role,
        tableName: t.tableName,
        provisionedRead: base.read,
        provisionedWrite: base.write,
        gsis: (desc.GlobalSecondaryIndexes ?? []).map((gsi, j): CapacityGsiSummary => {
          const p = provisionedOf(gsi.ProvisionedThroughput);
          const throttleIds = gsiThrottleById.get(gsi.IndexName ?? `gsi${j}`);
          return {
            indexName: gsi.IndexName ?? `gsi${j}`,
            provisionedRead: p.read,
            provisionedWrite: p.write,
            readThrottleEvents: throttleIds ? sum(seriesOf(throttleIds.read)) : 0,
            writeThrottleEvents: throttleIds ? sum(seriesOf(throttleIds.write)) : 0,
          };
        }),
        consumedReadPerSecAvg: round3(sum(seriesOf(ids.consumedRead)) / windowSeconds),
        consumedWritePerSecAvg: round3(sum(seriesOf(ids.consumedWrite)) / windowSeconds),
        consumedReadPerSecPeak: round3(max(seriesOf(ids.consumedRead)) / PERIOD_SECONDS),
        consumedWritePerSecPeak: round3(max(seriesOf(ids.consumedWrite)) / PERIOD_SECONDS),
        readThrottleEvents: sum(seriesOf(ids.readThrottle)),
        writeThrottleEvents: sum(seriesOf(ids.writeThrottle)),
      };
    }),
  };
}
