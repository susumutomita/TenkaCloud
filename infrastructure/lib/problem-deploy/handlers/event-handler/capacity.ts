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
import type { EventSharedResources } from "./shared.js";

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
 * 監視ビューは「見えているのに間違っている」が最悪 (throttle 中に緑を出す) なので、部分欠損は
 * すべて fail loudly: CloudWatch の欠損 series / 非 Complete StatusCode / 予期しない pagination、
 * DescribeTable の欠損 (Table / ProvisionedThroughput / IndexName) はエラーにして route の 5xx に
 * 変換する (silent zero は返さない)。
 *
 * AGENTS.md の方針どおり frontend は polling でこの route を叩く (SSE/WS なし)。
 * write 側 (`POST /admin/capacity` の runbook 起動、Issue #2680) は `capacity-scale.ts`。
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
  /** false when the selected control-data backend has no DynamoDB tables to monitor. */
  readonly applicable: boolean;
  /** Machine-readable explanation for a non-applicable overview. */
  readonly reason?: "dynamodb_not_in_use";
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

/**
 * event-hot テーブルを解決する。deployments/disruptions は既存の {@link EventSharedResources}
 * (= cold start で getEnv fail-fast 済み) から、problemEndpoints だけ本 slice で追加した env
 * から読む。
 *
 * events/teams/problemEndpoints は [Issue #2440、Issue #2442]
 * 純 SQL backend (turso) 選択時は table 自体が synth されず env も空文字になる
 * (`event-handler/shared.ts` / `generic-scoring-handler/shared.ts` 側で fail-fast を緩和済み)。
 * その場合はこの role を **監視対象から外す** (= DescribeTable(TableName="") で fail するのを
 * 防ぐ)。dynamodb backend では従来どおり 5 role とも揃う。
 *
 * この並びは stack 側の `EventCapacityRunbook` 配線 (allowedValues + IAM) と
 * `docs/operations/dynamodb-event-capacity.md` の表と対応する。event-hot テーブルを増減する
 * ときは 3 箇所を揃えること。
 */
export function resolveEventHotTables(
  shared: Pick<
    EventSharedResources,
    "deploymentsTableName" | "eventsTableName" | "teamsTableName" | "disruptionsTableName"
  >,
): readonly EventHotTable[] {
  const problemEndpointsTableName = process.env.PROBLEM_ENDPOINTS_TABLE_NAME ?? "";
  const tables: EventHotTable[] = [
    { role: "deployments", tableName: shared.deploymentsTableName },
    { role: "events", tableName: shared.eventsTableName },
    { role: "teams", tableName: shared.teamsTableName },
    { role: "problemEndpoints", tableName: problemEndpointsTableName },
    { role: "disruptions", tableName: shared.disruptionsTableName },
  ];
  return tables.filter((t) => t.tableName.length > 0);
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

/** 1 テーブル分の probe (テーブル・DescribeTable 結果・metric series id を 1 レコードに束ねる)。 */
interface TableProbe {
  readonly role: CapacityTableRole;
  readonly tableName: string;
  readonly desc: TableDescription;
  readonly consumedReadId: string;
  readonly consumedWriteId: string;
  readonly readThrottleId: string;
  readonly writeThrottleId: string;
  readonly gsis: readonly {
    readonly indexName: string;
    readonly readThrottleId: string;
    readonly writeThrottleId: string;
  }[];
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

/**
 * DescribeTable 結果から provisioned RCU/WCU を取り出す。欠損は fail loudly — 本 platform は
 * `DynamoDbLowCapacity` Aspect で PROVISIONED 固定なので、ProvisionedThroughput 欠損 (= out-of-band
 * で on-demand 化された等) は「0/0 で緑」ではなくエラーとして運営に見せるべき異常。
 */
function requireProvisioned(
  throughput: { ReadCapacityUnits?: number; WriteCapacityUnits?: number } | undefined,
  context: string,
): { read: number; write: number } {
  const read = throughput?.ReadCapacityUnits;
  const write = throughput?.WriteCapacityUnits;
  if (read === undefined || write === undefined) {
    throw new Error(
      `DescribeTable returned no provisioned throughput for ${context} (drifted to on-demand?)`,
    );
  }
  return { read, write };
}

/** DescribeTable + metric series id 割当。GSI の IndexName 欠損はここで fail loudly。 */
async function probeTables(
  tables: readonly EventHotTable[],
  ddb: Pick<DynamoDBClient, "send">,
): Promise<readonly TableProbe[]> {
  return Promise.all(
    tables.map(async (t, i): Promise<TableProbe> => {
      const out = await ddb.send(new DescribeTableCommand({ TableName: t.tableName }));
      const desc = (out as { Table?: TableDescription }).Table;
      if (!desc) {
        throw new Error(`DescribeTable returned no table description for ${t.tableName}`);
      }
      return {
        role: t.role,
        tableName: t.tableName,
        desc,
        consumedReadId: `t${i}cr`,
        consumedWriteId: `t${i}cw`,
        readThrottleId: `t${i}rt`,
        writeThrottleId: `t${i}wt`,
        gsis: (desc.GlobalSecondaryIndexes ?? []).map((gsi, j) => {
          if (!gsi.IndexName) {
            throw new Error(`DescribeTable returned a GSI without IndexName on ${t.tableName}`);
          }
          return {
            indexName: gsi.IndexName,
            readThrottleId: `t${i}g${j}rt`,
            writeThrottleId: `t${i}g${j}wt`,
          };
        }),
      };
    }),
  );
}

function buildMetricQueries(probes: readonly TableProbe[]): MetricDataQuery[] {
  const queries: MetricDataQuery[] = [];
  for (const probe of probes) {
    const dim = [{ Name: "TableName", Value: probe.tableName }];
    queries.push(
      metricQuery(probe.consumedReadId, "ConsumedReadCapacityUnits", dim),
      metricQuery(probe.consumedWriteId, "ConsumedWriteCapacityUnits", dim),
      metricQuery(probe.readThrottleId, "ReadThrottleEvents", dim),
      metricQuery(probe.writeThrottleId, "WriteThrottleEvents", dim),
    );
    for (const gsi of probe.gsis) {
      const gsiDim = [...dim, { Name: "GlobalSecondaryIndexName", Value: gsi.indexName }];
      queries.push(
        metricQuery(gsi.readThrottleId, "ReadThrottleEvents", gsiDim),
        metricQuery(gsi.writeThrottleId, "WriteThrottleEvents", gsiDim),
      );
    }
  }
  return queries;
}

/**
 * GetMetricData response を series id → datapoints に引き当てる。欠損 series / 非 Complete
 * StatusCode (InternalError / PartialData) / 予期しない NextToken は fail loudly — 「throttle=0」に
 * 見える partial view を返すと、運営が throttle 中に scale-up を見送る事故になる。
 * (query 数は 5 テーブル + 全 GSI でも数十件 = GetMetricData の 1 page (500 series) に収まる想定。)
 */
function indexMetricResults(
  metricData: {
    NextToken?: string;
    MetricDataResults?: { Id?: string; StatusCode?: string; Values?: number[] }[];
  },
  queries: readonly MetricDataQuery[],
): (id: string) => readonly number[] {
  if (metricData.NextToken) {
    throw new Error("GetMetricData returned an unexpected paginated response (NextToken set)");
  }
  const incomplete: string[] = [];
  const valuesById = new Map<string, readonly number[]>();
  for (const result of metricData.MetricDataResults ?? []) {
    if (!result.Id) continue;
    if (result.StatusCode !== undefined && result.StatusCode !== "Complete") {
      incomplete.push(`${result.Id}=${result.StatusCode}`);
      continue;
    }
    valuesById.set(result.Id, result.Values ?? []);
  }
  if (incomplete.length > 0) {
    throw new Error(`GetMetricData returned incomplete series: ${incomplete.join(", ")}`);
  }
  const missing = queries.map((q) => q.Id ?? "").filter((id) => id !== "" && !valuesById.has(id));
  if (missing.length > 0) {
    throw new Error(`GetMetricData response is missing series: ${missing.join(", ")}`);
  }
  return (id) => {
    const values = valuesById.get(id);
    /* v8 ignore next -- 上の missing 検査で不到達 (防御) */
    if (!values) throw new Error(`GetMetricData response is missing series: ${id}`);
    return values;
  };
}

export async function getCapacityOverview(
  shared: Pick<
    EventSharedResources,
    "deploymentsTableName" | "eventsTableName" | "teamsTableName" | "disruptionsTableName"
  >,
  opts: {
    readonly windowMinutes: number;
    /** テスト注入用。省略時は現在時刻。 */
    readonly now?: Date;
    /** テスト注入用。省略時は module-scope の production clients。 */
    readonly clients?: CapacityClients;
  },
): Promise<CapacityOverview> {
  const tables = resolveEventHotTables(shared);
  const now = opts.now ?? new Date();

  // A pure SQL backend deliberately synthesizes none of the five event-hot DynamoDB tables.
  // Return an explicit capability signal before constructing AWS clients or sending an invalid
  // GetMetricData request with zero queries.
  if (tables.length === 0) {
    return {
      applicable: false,
      reason: "dynamodb_not_in_use",
      windowMinutes: opts.windowMinutes,
      ceiling: EVENT_CAPACITY_CEILING,
      runbookDocumentName: null,
      generatedAt: now.toISOString(),
      tables: [],
    };
  }

  const clients = opts.clients ?? defaultCapacityClients();

  // Metric query は DescribeTable の GSI 一覧に依存するため 2 段 (probe → GetMetricData)。
  // GSI 構成は deploy でしか変わらないが、キャパ値は runbook で runtime に変わるので
  // DescribeTable を毎回引く (= 鮮度優先。 module-scope cache にはしない)。
  const probes = await probeTables(tables, clients.ddb);
  const queries = buildMetricQueries(probes);

  const metricData = await clients.cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(now.getTime() - opts.windowMinutes * 60_000),
      EndTime: now,
      MetricDataQueries: queries,
    }),
  );
  const seriesOf = indexMetricResults(metricData, queries);

  const windowSeconds = opts.windowMinutes * 60;
  return {
    applicable: true,
    windowMinutes: opts.windowMinutes,
    ceiling: EVENT_CAPACITY_CEILING,
    runbookDocumentName: process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME || null,
    generatedAt: now.toISOString(),
    tables: probes.map((probe): CapacityTableSummary => {
      const base = requireProvisioned(probe.desc.ProvisionedThroughput, probe.tableName);
      const descGsis = probe.desc.GlobalSecondaryIndexes ?? [];
      return {
        role: probe.role,
        tableName: probe.tableName,
        provisionedRead: base.read,
        provisionedWrite: base.write,
        // probe.gsis は descGsis と同一走査で作っているので位置対応が保証される。
        gsis: probe.gsis.map((gsi, j): CapacityGsiSummary => {
          const p = requireProvisioned(
            descGsis[j]?.ProvisionedThroughput,
            `${probe.tableName}/${gsi.indexName}`,
          );
          return {
            indexName: gsi.indexName,
            provisionedRead: p.read,
            provisionedWrite: p.write,
            readThrottleEvents: sum(seriesOf(gsi.readThrottleId)),
            writeThrottleEvents: sum(seriesOf(gsi.writeThrottleId)),
          };
        }),
        consumedReadPerSecAvg: round3(sum(seriesOf(probe.consumedReadId)) / windowSeconds),
        consumedWritePerSecAvg: round3(sum(seriesOf(probe.consumedWriteId)) / windowSeconds),
        consumedReadPerSecPeak: round3(max(seriesOf(probe.consumedReadId)) / PERIOD_SECONDS),
        consumedWritePerSecPeak: round3(max(seriesOf(probe.consumedWriteId)) / PERIOD_SECONDS),
        readThrottleEvents: sum(seriesOf(probe.readThrottleId)),
        writeThrottleEvents: sum(seriesOf(probe.writeThrottleId)),
      };
    }),
  };
}
