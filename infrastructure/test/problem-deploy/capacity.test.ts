import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_WINDOW_DEFAULT_MINUTES,
  CapacityQuerySchema,
  CapacityUnconfiguredError,
  getCapacityOverview,
  resolveEventHotTables,
} from "../../lib/problem-deploy/handlers/event-handler/capacity";

/**
 * Issue #2410 Slice 2: capacity overview service unit tests.
 * AWS clients are injected fakes; env carries the 5 event-hot table names the
 * EventApiLambda construct wires in production.
 */

const TABLE_ENVS = {
  DEPLOYMENTS_TABLE_NAME: "Deployments-x",
  EVENTS_TABLE_NAME: "Events-x",
  TEAMS_TABLE_NAME: "Teams-x",
  PROBLEM_ENDPOINTS_TABLE_NAME: "Endpoints-x",
  DISRUPTIONS_TABLE_NAME: "Disruptions-x",
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

function buildClients(metricResults: readonly { Id: string; Values: number[] }[]) {
  const ddbSend = vi.fn(async (cmd: unknown) => {
    const name = (cmd as DescribeTableCommand).input.TableName as string;
    if (name === TABLE_ENVS.DEPLOYMENTS_TABLE_NAME) return describeWithGsi(name);
    return plainDescription(name);
  });
  const cwSend = vi.fn(async () => ({ MetricDataResults: [...metricResults] }));
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
  for (const [key, value] of Object.entries(TABLE_ENVS)) process.env[key] = value;
  delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;
});

afterEach(() => {
  for (const key of Object.keys(TABLE_ENVS)) delete process.env[key];
  delete process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME;
});

describe("resolveEventHotTables", () => {
  it("should resolve the 5 event-hot tables from env in stable role order", () => {
    expect(resolveEventHotTables()).toEqual([
      { role: "deployments", tableName: "Deployments-x" },
      { role: "events", tableName: "Events-x" },
      { role: "teams", tableName: "Teams-x" },
      { role: "problemEndpoints", tableName: "Endpoints-x" },
      { role: "disruptions", tableName: "Disruptions-x" },
    ]);
  });

  it("should throw CapacityUnconfiguredError when a table env is missing (no partial view)", () => {
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
    expect(() => resolveEventHotTables()).toThrow(CapacityUnconfiguredError);
    expect(() => resolveEventHotTables()).toThrow(/PROBLEM_ENDPOINTS_TABLE_NAME/);
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
  it("should combine DescribeTable provisioning with CloudWatch consumption and throttles", async () => {
    const { clients } = buildClients([
      // Deployments base: consumed read 60/min + 120/min, write 30/min; throttled reads 2+1
      { Id: "t0cr", Values: [60, 120] },
      { Id: "t0cw", Values: [30] },
      { Id: "t0rt", Values: [2, 1] },
      { Id: "t0wt", Values: [] },
      // Deployments GSI1 throttles
      { Id: "t0g0rt", Values: [4] },
      { Id: "t0g0wt", Values: [5, 6] },
    ]);

    const overview = await getCapacityOverview({ windowMinutes: 30, now: NOW, clients });

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
    const { clients, cwSend } = buildClients([]);

    await getCapacityOverview({ windowMinutes: 15, now: NOW, clients });

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

  it("should echo the runbook document name from env, and null when unwired", async () => {
    const { clients } = buildClients([]);
    const unwired = await getCapacityOverview({ windowMinutes: 30, now: NOW, clients });
    expect(unwired.runbookDocumentName).toBeNull();

    process.env.CAPACITY_RUNBOOK_DOCUMENT_NAME = "stack-event-capacity";
    const wired = await getCapacityOverview({ windowMinutes: 30, now: NOW, clients });
    expect(wired.runbookDocumentName).toBe("stack-event-capacity");
  });

  it("should describe all 5 event-hot tables", async () => {
    const { clients, ddbSend } = buildClients([]);

    await getCapacityOverview({ windowMinutes: 30, now: NOW, clients });

    const described = ddbSend.mock.calls.map(
      (call) => (call[0] as DescribeTableCommand).input.TableName,
    );
    expect(described.sort()).toEqual(Object.values(TABLE_ENVS).sort());
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
  });
});
