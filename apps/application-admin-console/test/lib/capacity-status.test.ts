import { describe, expect, it } from "vitest";
import type { CapacityOverview, CapacityTableSummary } from "../../src/api/capacity-client";
import {
  buildCapacityRows,
  buildRunbookCommand,
  classifyTable,
  HOT_UTILIZATION_THRESHOLD,
  peakUtilization,
  totalThrottleEvents,
} from "../../src/lib/capacity-status";

/** Issue #2410 Slice 2: pure classification / formatting logic for the capacity panel. */

const baseTable: CapacityTableSummary = {
  role: "deployments",
  tableName: "Deployments-x",
  provisionedRead: 5,
  provisionedWrite: 2,
  gsis: [],
  consumedReadPerSecAvg: 0.1,
  consumedWritePerSecAvg: 0.05,
  consumedReadPerSecPeak: 1,
  consumedWritePerSecPeak: 0.2,
  readThrottleEvents: 0,
  writeThrottleEvents: 0,
};

describe("totalThrottleEvents", () => {
  it("should sum base table and GSI throttle events", () => {
    const table: CapacityTableSummary = {
      ...baseTable,
      readThrottleEvents: 1,
      writeThrottleEvents: 2,
      gsis: [
        {
          indexName: "GSI1",
          provisionedRead: 1,
          provisionedWrite: 1,
          readThrottleEvents: 3,
          writeThrottleEvents: 4,
        },
      ],
    };
    expect(totalThrottleEvents(table)).toBe(10);
  });
});

describe("peakUtilization", () => {
  it("should divide peak consumption by provisioned capacity", () => {
    expect(peakUtilization(4, 5)).toBe(0.8);
  });

  it("should treat non-positive provisioning as zero utilization", () => {
    expect(peakUtilization(4, 0)).toBe(0);
  });
});

describe("classifyTable", () => {
  it("should classify any throttle event as throttling, even with low utilization", () => {
    expect(classifyTable({ ...baseTable, writeThrottleEvents: 1 })).toBe("throttling");
  });

  it("should classify a GSI-only throttle as throttling", () => {
    const table: CapacityTableSummary = {
      ...baseTable,
      gsis: [
        {
          indexName: "GSI1",
          provisionedRead: 1,
          provisionedWrite: 1,
          readThrottleEvents: 1,
          writeThrottleEvents: 0,
        },
      ],
    };
    expect(classifyTable(table)).toBe("throttling");
  });

  it(`should classify peak read utilization at ${HOT_UTILIZATION_THRESHOLD} as hot`, () => {
    expect(classifyTable({ ...baseTable, consumedReadPerSecPeak: 4 })).toBe("hot");
  });

  it("should classify peak write utilization above the threshold as hot", () => {
    expect(classifyTable({ ...baseTable, consumedWritePerSecPeak: 1.9 })).toBe("hot");
  });

  it("should classify a table with headroom and no throttles as ok", () => {
    expect(classifyTable(baseTable)).toBe("ok");
  });
});

describe("buildCapacityRows", () => {
  it("should build display rows with labels and health per table", () => {
    const overview: CapacityOverview = {
      windowMinutes: 30,
      ceiling: 200,
      runbookDocumentName: "stack-event-capacity",
      generatedAt: "2026-07-07T12:00:00.000Z",
      tables: [
        baseTable,
        { ...baseTable, role: "events", tableName: "Events-x", readThrottleEvents: 7 },
      ],
    };

    const rows = buildCapacityRows(overview);

    expect(rows).toEqual([
      {
        role: "deployments",
        tableName: "Deployments-x",
        health: "ok",
        provisionedLabel: "5 / 2",
        consumedReadLabel: "0.1 → 1",
        consumedWriteLabel: "0.05 → 0.2",
        throttleEvents: 0,
      },
      {
        role: "events",
        tableName: "Events-x",
        health: "throttling",
        provisionedLabel: "5 / 2",
        consumedReadLabel: "0.1 → 1",
        consumedWriteLabel: "0.05 → 0.2",
        throttleEvents: 7,
      },
    ]);
  });
});

describe("buildRunbookCommand", () => {
  it("should build the start-automation-execution command with placeholders for RCU/WCU", () => {
    const command = buildRunbookCommand("stack-event-capacity", "Deployments-x");
    expect(command).toContain("aws ssm start-automation-execution");
    expect(command).toContain("--document-name stack-event-capacity");
    expect(command).toContain(
      "TableName=Deployments-x,ReadCapacityUnits=<RCU>,WriteCapacityUnits=<WCU>",
    );
  });
});
