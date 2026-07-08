import { describe, expect, it } from "vitest";
import {
  type AwsResult,
  type AwsRunner,
  buildRetainedTablesWarning,
  collectRetainedTables,
  estimateMonthlyCostUsd,
  isTenkaCloudTable,
  MONTHLY_COST_PER_UNIT_PAIR_USD,
  parseGsiCount,
  parseTableNames,
  type RetainedTable,
  reportRetainedTables,
  totalUnitPairs,
  unitPairsFor,
} from "../../../scripts/lib/retained-tables";

/**
 * Issue #2444: destroy 後の RETAIN テーブル残存警告ロジックの pin。
 *
 * aws CLI を AwsRunner seam で注入するので AWS を触らずに全経路 (list 失敗 / 残ゼロ /
 * 残あり / describe 失敗 / throw) を観測できる。 削除コマンドは一切 spawn しない。
 */

/** args ごとに応答を返す fake aws runner を作る (呼び出しは配列に記録する)。 */
function fakeRunner(respond: (args: readonly string[]) => AwsResult): {
  readonly run: AwsRunner;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const run: AwsRunner = async (args) => {
    calls.push([...args]);
    return respond(args);
  };
  return { run, calls };
}

const ok = (stdout: string): AwsResult => ({ code: 0, stdout, stderr: "" });
const fail = (): AwsResult => ({ code: 255, stdout: "", stderr: "boom" });

describe("isTenkaCloudTable (#2444)", () => {
  it("should match the tenkacloud stack-name prefix case-insensitively", () => {
    expect(isTenkaCloudTable("tenkacloud-lite-EventsTableABC-XYZ")).toBe(true);
    expect(isTenkaCloudTable("TenkaCloud-lite-problem-deploy-TeamsTable")).toBe(true);
  });

  it("should reject tables that do not carry the tenkacloud prefix", () => {
    expect(isTenkaCloudTable("some-other-project-Table")).toBe(false);
    expect(isTenkaCloudTable("SBTControlPlaneTable")).toBe(false);
  });
});

describe("cost model (#2444)", () => {
  it("should count one unit pair for a base table plus one per GSI", () => {
    expect(unitPairsFor({ name: "t", gsiCount: 0 })).toBe(1);
    expect(unitPairsFor({ name: "t", gsiCount: 3 })).toBe(4);
  });

  it("should sum unit pairs across every retained table", () => {
    const tables: RetainedTable[] = [
      { name: "a", gsiCount: 0 },
      { name: "b", gsiCount: 2 },
    ];
    expect(totalUnitPairs(tables)).toBe(4); // (1) + (1+2)
  });

  it("should price the Lite-mode footprint (8 tables + 8 GSIs = 16 pairs)", () => {
    const liteTables: RetainedTable[] = [
      { name: "events", gsiCount: 1 },
      { name: "deployments", gsiCount: 3 },
      { name: "disruptions", gsiCount: 1 },
      { name: "admin-audit-log", gsiCount: 1 },
      { name: "competitor-accounts", gsiCount: 0 },
      { name: "teams", gsiCount: 2 },
      { name: "problem-endpoints", gsiCount: 0 },
      { name: "saml-idps", gsiCount: 0 },
    ];
    expect(totalUnitPairs(liteTables)).toBe(16);
    expect(estimateMonthlyCostUsd(liteTables)).toBeCloseTo(16 * MONTHLY_COST_PER_UNIT_PAIR_USD);
    expect(estimateMonthlyCostUsd(liteTables)).toBeCloseTo(10.24);
  });
});

describe("parseTableNames (#2444)", () => {
  it("should extract a string array of table names", () => {
    expect(parseTableNames('{"TableNames":["a","b"]}')).toEqual(["a", "b"]);
  });

  it("should return undefined when TableNames is missing, non-array, or non-string", () => {
    expect(parseTableNames('{"other":1}')).toBeUndefined();
    expect(parseTableNames('{"TableNames":"nope"}')).toBeUndefined();
    expect(parseTableNames('{"TableNames":[1,2]}')).toBeUndefined();
    expect(parseTableNames("null")).toBeUndefined();
  });

  it("should return undefined on invalid JSON", () => {
    expect(parseTableNames("")).toBeUndefined();
    expect(parseTableNames("not json")).toBeUndefined();
  });
});

describe("parseGsiCount (#2444)", () => {
  it("should count entries when the query returns a GSI array", () => {
    expect(parseGsiCount('[{"IndexName":"GSI1"},{"IndexName":"GSI2"}]')).toBe(2);
  });

  it("should treat null (no GSIs) or a non-array as zero", () => {
    expect(parseGsiCount("null")).toBe(0);
    expect(parseGsiCount('{"unexpected":true}')).toBe(0);
  });

  it("should treat invalid JSON as zero", () => {
    expect(parseGsiCount("")).toBe(0);
  });
});

describe("collectRetainedTables (#2444)", () => {
  it("should flag listFailed when list-tables exits non-zero", async () => {
    const { run } = fakeRunner(() => fail());
    const result = await collectRetainedTables(run);
    expect(result.listFailed).toBe(true);
    expect(result.tables).toEqual([]);
  });

  it("should return no tables (not a failure) when list output is unparseable", async () => {
    const { run } = fakeRunner(() => ok("garbage"));
    const result = await collectRetainedTables(run);
    expect(result.listFailed).toBe(false);
    expect(result.tables).toEqual([]);
  });

  it("should keep only tenkacloud tables and resolve each GSI count via describe-table", async () => {
    const { run, calls } = fakeRunner((args) => {
      if (args.includes("list-tables")) {
        return ok('{"TableNames":["tenkacloud-lite-Deployments","unrelated-Table"]}');
      }
      // describe-table for the deployments table → 3 GSIs.
      return ok('[{"IndexName":"GSI1"},{"IndexName":"GSI2"},{"IndexName":"GSI3"}]');
    });
    const result = await collectRetainedTables(run);
    expect(result.tables).toEqual([{ name: "tenkacloud-lite-Deployments", gsiCount: 3 }]);
    // describe-table should only be issued for the matched tenkacloud table.
    const describeCalls = calls.filter((c) => c.includes("describe-table"));
    expect(describeCalls).toHaveLength(1);
    expect(describeCalls[0]).toContain("tenkacloud-lite-Deployments");
  });

  it("should fall back to zero GSIs when describe-table fails", async () => {
    const { run } = fakeRunner((args) => {
      if (args.includes("list-tables")) return ok('{"TableNames":["tenkacloud-lite-Teams"]}');
      return fail();
    });
    const result = await collectRetainedTables(run);
    expect(result.tables).toEqual([{ name: "tenkacloud-lite-Teams", gsiCount: 0 }]);
  });
});

describe("buildRetainedTablesWarning (#2444)", () => {
  const tables: RetainedTable[] = [
    { name: "tenkacloud-lite-Deployments", gsiCount: 3 },
    { name: "tenkacloud-lite-CompetitorAccounts", gsiCount: 0 },
  ];
  const warning = buildRetainedTablesWarning(tables);

  it("should state the retained count and total estimated monthly cost", () => {
    expect(warning).toContain("RETAIN された DynamoDB テーブルが 2 件残っています");
    // (1+3) + (1+0) = 5 pairs × $0.64 = $3.20
    expect(warning).toContain("≈ $3.20/月");
    expect(warning).toContain("合計: 2 テーブル + 3 GSI = 5 ユニット組 ≈ $3.20/月");
  });

  it("should annotate GSI counts only when the table has GSIs", () => {
    expect(warning).toContain("tenkacloud-lite-Deployments (GSI 3 本)  ≈ $2.56/月");
    expect(warning).toContain("tenkacloud-lite-CompetitorAccounts  ≈ $0.64/月");
    expect(warning).not.toContain("CompetitorAccounts (GSI");
  });

  it("should offer a copy-paste delete-table command per table but never run it", () => {
    expect(warning).toContain("aws dynamodb delete-table --table-name tenkacloud-lite-Deployments");
    expect(warning).toContain(
      "aws dynamodb delete-table --table-name tenkacloud-lite-CompetitorAccounts",
    );
  });
});

describe("reportRetainedTables (#2444)", () => {
  function capture(): { readonly write: (t: string) => void; text: () => string } {
    const chunks: string[] = [];
    return { write: (t) => chunks.push(t), text: () => chunks.join("") };
  }

  it("should print nothing when no tenkacloud tables remain", async () => {
    const { run } = fakeRunner((args) =>
      args.includes("list-tables") ? ok('{"TableNames":["unrelated-Table"]}') : ok("null"),
    );
    const out = capture();
    await reportRetainedTables(run, out.write);
    expect(out.text()).toBe("");
  });

  it("should print the retained-table warning when tables remain", async () => {
    const { run } = fakeRunner((args) =>
      args.includes("list-tables")
        ? ok('{"TableNames":["tenkacloud-lite-Events"]}')
        : ok('[{"IndexName":"GSI1"}]'),
    );
    const out = capture();
    await reportRetainedTables(run, out.write);
    expect(out.text()).toContain("tenkacloud-lite-Events (GSI 1 本)");
    expect(out.text()).toContain("aws dynamodb delete-table --table-name tenkacloud-lite-Events");
  });

  it("should print a skipped note (not throw) when list-tables fails", async () => {
    const { run } = fakeRunner(() => fail());
    const out = capture();
    await reportRetainedTables(run, out.write);
    expect(out.text()).toContain("残存確認をスキップしました");
  });

  it("should print a skipped note (not throw) when the runner itself rejects", async () => {
    const rejectingRunner: AwsRunner = async () => {
      throw new Error("aws binary not found");
    };
    const out = capture();
    await expect(reportRetainedTables(rejectingRunner, out.write)).resolves.toBeUndefined();
    expect(out.text()).toContain("残存確認をスキップしました");
  });
});
