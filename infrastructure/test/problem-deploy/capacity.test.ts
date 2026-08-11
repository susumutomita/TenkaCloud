import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_WINDOW_DEFAULT_MINUTES,
  CapacityQuerySchema,
  getCapacityOverview,
  resolveEventHotTables,
} from "../../lib/problem-deploy/handlers/event-handler/capacity";

/**
 * Issue #2410 Slice 2: capacity overview service unit tests.
 * The 4 legacy table names come from the shared resources (as in production);
 * the 5th (ProblemEndpoints) and the runbook document name come from env.
 * AWS clients are injected fakes.
 */

const SHARED = {
  deploymentsTableName: "Deployments-x",
  eventsTableName: "Events-x",
  teamsTableName: "Teams-x",
  disruptionsTableName: "Disruptions-x",
} as const;

const NOW = new Date("2026-07-07T12:00:00.000Z");

function plainDescription(tableName: string) {
  return {
    Table: {
      TableName: tableName,
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    },
  };
}

function describeWithGsi(tableName: string) {
  return {
    Table: {
      TableName: tableName,
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 1 },
        },
      ],
    },
  };
}

interface FakeOptions {
  /** series id → per-minute datapoints。未指定 id は [] (静かなテーブル)。 */
  readonly values?: Record<string, number[]>;
  /** GetMetricData 応答からこの id の series を落とす (= 欠損 series の再現)。 */
  readonly omitIds?: readonly string[];
  /** series id → StatusCode 上書き ("Complete" 以外で incomplete を再現)。 */
  readonly statusCodes?: Record<string, string>;
  /** 応答に NextToken を付ける (= 予期しない pagination の再現)。 */
  readonly nextToken?: string;
  /** DescribeTable 応答の差し替え。 */
  readonly describe?: (tableName: string) => unknown;
}

function buildClients(opts: FakeOptions = {}) {
  const ddbSend = vi.fn(async (cmd: unknown) => {
    const name = (cmd as DescribeTableCommand).input.TableName as string;
    if (opts.describe) return opts.describe(name);
    if (name === SHARED.deploymentsTableName) return describeWithGsi(name);
    return plainDescription(name);
  });
  // GetMetricData fake は投げられた query 全 id に "Complete" な series を返す (実 AWS の
  // 挙動と同じ)。欠損 / incomplete / pagination は opts で明示的に注入する。
  const cwSend = vi.fn(async (cmd: unknown) => {
    const input = (cmd as GetMetricDataCommand).input;
    return {
      ...(opts.nextToken ? { NextToken: opts.nextToken } : {}),
      MetricDataResults: (input.MetricDataQueries ?? [])
        .filter((q) => !(opts.omitIds ?? []).includes(q.Id ?? ""))
        .map((q) => ({
          Id: q.Id,
          StatusCode: opts.statusCodes?.[q.Id ?? ""] ?? "Complete",
          Values: opts.values?.[q.Id ?? ""] ?? [],
        })),
    };
  });
  return {
    clients: {
      ddb: { send: ddbSend as never },
      cw: { send: cwSend as never },
    },
    ddbSend,
    cwSend,
  };
}

beforeEach(() => {
  process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "Endpoints-x";
  delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;
});

afterEach(() => {
  delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;
});

describe("resolveEventHotTables", () => {
  it("should resolve the 5 event-hot tables (4 from shared, ProblemEndpoints from env) in stable role order", () => {
    expect(resolveEventHotTables(SHARED)).toEqual([
      { role: "deployments", tableName: "Deployments-x" },
      { role: "events", tableName: "Events-x" },
      { role: "teams", tableName: "Teams-x" },
      { role: "problemEndpoints", tableName: "Endpoints-x" },
      { role: "disruptions", tableName: "Disruptions-x" },
    ]);
  });

  // Issue #2442 (Phase C1): pure SQL backend (turso|sql) では ProblemEndpoints table 自体も
  // synth されず、shared builder はその table 名 env を空文字にフォールバックする
  // (generic-scoring-handler/shared.ts 参照)。events/teams と同じ緩和: throw ではなく監視対象
  // から除外する (= 残り 4 role で capacity overview は動作する)。
  it("should drop the problemEndpoints role whose tableName is empty (pure SQL backend, no partial-view crash)", () => {
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
    expect(resolveEventHotTables(SHARED)).toEqual([
      { role: "deployments", tableName: "Deployments-x" },
      { role: "events", tableName: "Events-x" },
      { role: "teams", tableName: "Teams-x" },
      { role: "disruptions", tableName: "Disruptions-x" },
    ]);
  });

  // Issue #2440: pure SQL backend (turso|sql) では Events/Teams table
  // 自体が synth されず、shared builder はそれらの table 名 env を空文字にフォールバックする
  // (event-handler/shared.ts 参照)。DescribeTable(TableName="") で fail するのを防ぐため、
  // 空 tableName の role は監視対象から除外する (= 残り 3 role で capacity overview は動作する)。
  it("should drop events/teams roles whose tableName is empty (pure SQL backend, no partial-view crash)", () => {
    expect(resolveEventHotTables({ ...SHARED, eventsTableName: "", teamsTableName: "" })).toEqual([
      { role: "deployments", tableName: "Deployments-x" },
      { role: "problemEndpoints", tableName: "Endpoints-x" },
      { role: "disruptions", tableName: "Disruptions-x" },
    ]);
  });

  it("should return no event-hot tables when every DynamoDB role is absent in a pure SQL backend", () => {
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
    expect(
      resolveEventHotTables({
        deploymentsTableName: "",
        eventsTableName: "",
        teamsTableName: "",
        disruptionsTableName: "",
      }),
    ).toEqual([]);
  });
});

describe("CapacityQuerySchema", () => {
  it("should default windowMinutes to 30", () => {
    expect(CapacityQuerySchema.parse({})).toEqual({
      windowMinutes: CAPACITY_WINDOW_DEFAULT_MINUTES,
    });
  });

  it("should coerce a string query value to an integer", () => {
    expect(CapacityQuerySchema.parse({ windowMinutes: "60" })).toEqual({ windowMinutes: 60 });
  });

  it.each([
    "4",
    "181",
    "abc",
    "30.5",
  ])("should reject out-of-range or non-integer windowMinutes %s", (value) => {
    expect(CapacityQuerySchema.safeParse({ windowMinutes: value }).success).toBe(false);
  });
});

describe("getCapacityOverview", () => {
  it("should return not-applicable without calling AWS when a pure SQL backend has no DynamoDB tables", async () => {
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
    const { clients, ddbSend, cwSend } = buildClients();

    const overview = await getCapacityOverview(
      {
        deploymentsTableName: "",
        eventsTableName: "",
        teamsTableName: "",
        disruptionsTableName: "",
      },
      { windowMinutes: 30, now: NOW, clients },
    );

    expect(overview).toEqual({
      applicable: false,
      reason: "dynamodb_not_in_use",
      windowMinutes: 30,
      ceiling: 200,
      runbookDocumentName: null,
      generatedAt: NOW.toISOString(),
      tables: [],
    });
    expect(ddbSend).not.toHaveBeenCalled();
    expect(cwSend).not.toHaveBeenCalled();
  });

  it("should combine DescribeTable provisioning with CloudWatch consumption and throttles", async () => {
    const { clients } = buildClients({
      values: {
        // Deployments base: consumed read 60/min + 120/min, write 30/min; throttled reads 2+1
        t0cr: [60, 120],
        t0cw: [30],
        t0rt: [2, 1],
        // Deployments GSI1 throttles
        t0g0rt: [4],
        t0g0wt: [5, 6],
      },
    });

    const overview = await getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients });

    expect(overview.applicable).toBe(true);
    expect(overview.windowMinutes).toBe(30);
    expect(overview.ceiling).toBe(200);
    expect(overview.generatedAt).toBe(NOW.toISOString());
    expect(overview.tables).toHaveLength(5);

    const deployments = overview.tables[0];
    expect(deployments).toMatchObject({
      role: "deployments",
      tableName: "Deployments-x",
      provisionedRead: 5,
      provisionedWrite: 2,
      // (60+120) RCU over 1800s window
      consumedReadPerSecAvg: 0.1,
      // hottest minute = 120 RCU / 60s
      consumedReadPerSecPeak: 2,
      consumedWritePerSecAvg: Math.round((30 / 1800) * 1000) / 1000,
      consumedWritePerSecPeak: 0.5,
      readThrottleEvents: 3,
      writeThrottleEvents: 0,
    });
    expect(deployments?.gsis).toEqual([
      {
        indexName: "GSI1",
        provisionedRead: 3,
        provisionedWrite: 1,
        readThrottleEvents: 4,
        writeThrottleEvents: 11,
      },
    ]);

    // Tables with no metric datapoints report flat zeros (quiet event).
    const events = overview.tables[1];
    expect(events).toMatchObject({
      role: "events",
      provisionedRead: 1,
      provisionedWrite: 1,
      consumedReadPerSecAvg: 0,
      consumedReadPerSecPeak: 0,
      readThrottleEvents: 0,
      writeThrottleEvents: 0,
      gsis: [],
    });
  });

  it("should query CloudWatch once for the whole window with per-table and per-GSI series", async () => {
    const { clients, cwSend } = buildClients();

    await getCapacityOverview(SHARED, { windowMinutes: 15, now: NOW, clients });

    expect(cwSend).toHaveBeenCalledTimes(1);
    const cmd = cwSend.mock.calls[0]?.[0] as GetMetricDataCommand;
    expect(cmd).toBeInstanceOf(GetMetricDataCommand);
    expect(cmd.input.StartTime).toEqual(new Date(NOW.getTime() - 15 * 60_000));
    expect(cmd.input.EndTime).toEqual(NOW);
    // 5 tables x 4 base series + 1 GSI x 2 throttle series = 22 queries
    expect(cmd.input.MetricDataQueries).toHaveLength(22);
    const gsiQuery = cmd.input.MetricDataQueries?.find((q) => q.Id === "t0g0rt");
    expect(gsiQuery?.MetricStat?.Metric?.Dimensions).toEqual([
      { Name: "TableName", Value: "Deployments-x" },
      { Name: "GlobalSecondaryIndexName", Value: "GSI1" },
    ]);
    expect(gsiQuery?.MetricStat?.Period).toBe(60);
    expect(gsiQuery?.MetricStat?.Stat).toBe("Sum");
  });

  it("should echo the runbook document name from env, and null when unwired or empty", async () => {
    const { clients } = buildClients();
    const unwired = await getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients });
    expect(unwired.runbookDocumentName).toBeNull();

    process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME = "";
    const empty = await getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients });
    expect(empty.runbookDocumentName).toBeNull();

    process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME = "stack-event-capacity";
    const wired = await getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients });
    expect(wired.runbookDocumentName).toBe("stack-event-capacity");
  });

  it("should describe all 5 event-hot tables", async () => {
    const { clients, ddbSend } = buildClients();

    await getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients });

    const described = ddbSend.mock.calls.map(
      (call) => (call[0] as DescribeTableCommand).input.TableName,
    );
    expect(described.sort()).toEqual(
      ["Deployments-x", "Events-x", "Teams-x", "Endpoints-x", "Disruptions-x"].sort(),
    );
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
  });

  // --- fail-loud paths: a partial monitoring view must never render as "all green" ---

  it("should fail loudly when GetMetricData paginates unexpectedly (NextToken)", async () => {
    const { clients } = buildClients({ nextToken: "tok" });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/paginated/);
  });

  it("should fail loudly when a series comes back incomplete (InternalError / PartialData)", async () => {
    const { clients } = buildClients({ statusCodes: { t0rt: "InternalError" } });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/incomplete series: t0rt=InternalError/);
  });

  it("should fail loudly when a queried series is missing from the response", async () => {
    const { clients } = buildClients({ omitIds: ["t1cw"] });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/missing series: t1cw/);
  });

  it("should fail loudly when DescribeTable returns no table description", async () => {
    const { clients } = buildClients({
      describe: (name) => (name === "Teams-x" ? {} : plainDescription(name)),
    });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/no table description for Teams-x/);
  });

  it("should fail loudly when a table has no provisioned throughput (on-demand drift)", async () => {
    const { clients } = buildClients({
      describe: (name) =>
        name === "Events-x" ? { Table: { TableName: name } } : plainDescription(name),
    });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/no provisioned throughput for Events-x/);
  });

  it("should fail loudly when a GSI has no provisioned throughput", async () => {
    const { clients } = buildClients({
      describe: (name) =>
        name === "Deployments-x"
          ? {
              Table: {
                TableName: name,
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
                GlobalSecondaryIndexes: [{ IndexName: "GSI1" }],
              },
            }
          : plainDescription(name),
    });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/no provisioned throughput for Deployments-x\/GSI1/);
  });

  it("should fail loudly when a GSI has no IndexName", async () => {
    const { clients } = buildClients({
      describe: (name) =>
        name === "Deployments-x"
          ? {
              Table: {
                TableName: name,
                ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
                GlobalSecondaryIndexes: [
                  { ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } },
                ],
              },
            }
          : plainDescription(name),
    });

    await expect(
      getCapacityOverview(SHARED, { windowMinutes: 30, now: NOW, clients }),
    ).rejects.toThrow(/GSI without IndexName on Deployments-x/);
  });
});
