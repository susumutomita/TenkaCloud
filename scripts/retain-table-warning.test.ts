import { describe, expect, it } from "bun:test";
import {
  type AwsRunner,
  type AwsRunResult,
  estimateMonthlyUsd,
  isTenkaCloudTable,
  listTenkaCloudTables,
  summarizeTable,
  USD_PER_UNIT_PAIR_MONTH,
  warnRetainedTables,
} from "./retain-table-warning";

/**
 * Build a fake `aws` CLI runner from canned responses. `listTables` returns the JSON body
 * of `list-tables`; `describe[name]` returns the `describe-table` body for that table.
 * Any command with no canned response resolves as a non-zero (denied) call.
 */
function fakeAws(config: {
  listTables?: { code?: number; stdout?: string };
  describe?: Record<string, { code?: number; stdout?: string }>;
  calls?: string[][];
}): AwsRunner {
  return async (args): Promise<AwsRunResult> => {
    config.calls?.push([...args]);
    const sub = args[1];
    if (sub === "list-tables") {
      const r = config.listTables ?? { code: 1, stdout: "" };
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
    }
    if (sub === "describe-table") {
      const nameIdx = args.indexOf("--table-name") + 1;
      const name = args[nameIdx];
      const r = config.describe?.[name];
      if (!r) return { code: 1, stdout: "", stderr: "not found" };
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

function listPayload(names: string[]): string {
  return JSON.stringify({ TableNames: names });
}

function tablePayload(rcu: number, wcu: number, gsis: [number, number][] = []): string {
  return JSON.stringify({
    Table: {
      ProvisionedThroughput: { ReadCapacityUnits: rcu, WriteCapacityUnits: wcu },
      GlobalSecondaryIndexes: gsis.map(([r, w]) => ({
        ProvisionedThroughput: { ReadCapacityUnits: r, WriteCapacityUnits: w },
      })),
    },
  });
}

/** Capture stdout / stderr text emitted by `warnRetainedTables`. */
function capture(): {
  out: string[];
  err: string[];
  io: (aws: AwsRunner) => Parameters<typeof warnRetainedTables>[0];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: (aws) => ({ aws, stdout: (t) => out.push(t), stderr: (t) => err.push(t) }),
  };
}

describe("isTenkaCloudTable", () => {
  it("should match tenkacloud-prefixed physical table names", () => {
    expect(isTenkaCloudTable("tenkacloud-lite-problem-deploy-EventsTable-ABC123")).toBe(true);
    expect(isTenkaCloudTable("tenkacloud-control-plane-TenantDetails-XYZ")).toBe(true);
  });

  it("should be case-insensitive on the prefix", () => {
    expect(isTenkaCloudTable("TenkaCloud-lite-Table-1")).toBe(true);
  });

  it("should ignore tables from other projects", () => {
    expect(isTenkaCloudTable("some-other-app-Table")).toBe(false);
    expect(isTenkaCloudTable("Deployments")).toBe(false);
  });
});

describe("estimateMonthlyUsd", () => {
  it("should price one unit pair (1 RCU + 1 WCU) at about $0.64 / month (ap-northeast-1)", () => {
    // Consistent with Issue #2444's stated estimate and #2435's $7.06 / ~37-unit reading.
    expect(estimateMonthlyUsd(1, 1)).toBeCloseTo(0.64, 2);
    expect(USD_PER_UNIT_PAIR_MONTH).toBeCloseTo(0.64, 2);
  });

  it("should scale linearly with provisioned units", () => {
    expect(estimateMonthlyUsd(16, 16)).toBeCloseTo(0.64 * 16, 1);
  });

  it("should charge nothing for zero provisioned capacity (on-demand)", () => {
    expect(estimateMonthlyUsd(0, 0)).toBe(0);
  });
});

describe("summarizeTable", () => {
  it("should sum base-table and GSI capacity units", () => {
    const summary = summarizeTable(
      "tenkacloud-lite-problem-deploy-DeploymentsTable-X",
      JSON.parse(
        tablePayload(1, 1, [
          [1, 1],
          [1, 1],
          [1, 1],
        ]),
      ),
    );
    expect(summary.readCapacityUnits).toBe(4);
    expect(summary.writeCapacityUnits).toBe(4);
    expect(summary.gsiCount).toBe(3);
    expect(summary.unitGroups).toBe(4);
  });

  it("should treat a missing throughput block as zero", () => {
    const summary = summarizeTable("tenkacloud-x", {});
    expect(summary.readCapacityUnits).toBe(0);
    expect(summary.writeCapacityUnits).toBe(0);
    expect(summary.unitGroups).toBe(1);
  });
});

describe("listTenkaCloudTables", () => {
  it("should keep only tenkacloud-prefixed tables", async () => {
    const aws = fakeAws({
      listTables: {
        code: 0,
        stdout: listPayload(["tenkacloud-lite-A", "unrelated-B", "tenkacloud-lite-C"]),
      },
    });
    expect(await listTenkaCloudTables(aws)).toEqual(["tenkacloud-lite-A", "tenkacloud-lite-C"]);
  });

  it("should follow LastEvaluatedTableName pagination", async () => {
    let page = 0;
    const aws: AwsRunner = async (args) => {
      if (args[1] !== "list-tables") return { code: 1, stdout: "", stderr: "" };
      page += 1;
      const body =
        page === 1
          ? JSON.stringify({ TableNames: ["tenkacloud-a"], LastEvaluatedTableName: "tenkacloud-a" })
          : JSON.stringify({ TableNames: ["tenkacloud-b"] });
      return { code: 0, stdout: body, stderr: "" };
    };
    expect(await listTenkaCloudTables(aws)).toEqual(["tenkacloud-a", "tenkacloud-b"]);
  });

  it("should return undefined when list-tables fails (no creds / denied)", async () => {
    const aws = fakeAws({ listTables: { code: 255, stdout: "" } });
    expect(await listTenkaCloudTables(aws)).toBeUndefined();
  });

  it("should return undefined on unparseable output", async () => {
    const aws = fakeAws({ listTables: { code: 0, stdout: "not json" } });
    expect(await listTenkaCloudTables(aws)).toBeUndefined();
  });
});

describe("warnRetainedTables", () => {
  it("should stay silent when no tenkacloud tables remain", async () => {
    const { out, err, io } = capture();
    const aws = fakeAws({ listTables: { code: 0, stdout: listPayload(["unrelated-only"]) } });
    await warnRetainedTables(io(aws));
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it("should print a single-line notice and not fail when credentials are invalid", async () => {
    const { out, err, io } = capture();
    const aws = fakeAws({ listTables: { code: 255, stdout: "" } });
    await warnRetainedTables(io(aws));
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("スキップ");
    // Exactly one line — a one-liner, not a multi-line dump.
    expect(err[0].trimEnd().split("\n")).toHaveLength(1);
  });

  it("should warn with correct unit sums, cost and per-table delete commands", async () => {
    const { out, err, io } = capture();
    const aws = fakeAws({
      listTables: {
        code: 0,
        stdout: listPayload(["tenkacloud-lite-Events", "tenkacloud-lite-Deployments", "unrelated"]),
      },
      describe: {
        "tenkacloud-lite-Events": { code: 0, stdout: tablePayload(1, 1, [[1, 1]]) },
        "tenkacloud-lite-Deployments": {
          code: 0,
          stdout: tablePayload(1, 1, [
            [1, 1],
            [1, 1],
            [1, 1],
          ]),
        },
      },
    });
    await warnRetainedTables(io(aws));
    const text = out.join("");
    expect(err).toEqual([]);
    // Events: 1 base + 1 GSI = 2 unit組; Deployments: 1 base + 3 GSI = 4 → total 6.
    expect(text).toContain("6 unit組");
    expect(text).toContain("RCU=6 + WCU=6");
    // 6 unit pairs ≈ $3.85 / month (6 * USD_PER_UNIT_PAIR_MONTH).
    expect(text).toContain(`$${estimateMonthlyUsd(6, 6).toFixed(2)}`);
    expect(text).toContain("aws dynamodb delete-table --table-name tenkacloud-lite-Events");
    expect(text).toContain("aws dynamodb delete-table --table-name tenkacloud-lite-Deployments");
    expect(text).not.toContain("unrelated");
    expect(text).toContain("意図的");
  });

  it("should skip tables that vanish between list and describe", async () => {
    const { out, io } = capture();
    const aws = fakeAws({
      listTables: { code: 0, stdout: listPayload(["tenkacloud-gone", "tenkacloud-here"]) },
      describe: { "tenkacloud-here": { code: 0, stdout: tablePayload(1, 1) } },
    });
    await warnRetainedTables(io(aws));
    const text = out.join("");
    expect(text).toContain("1 件");
    expect(text).toContain("tenkacloud-here");
    expect(text).not.toContain("tenkacloud-gone");
  });
});
