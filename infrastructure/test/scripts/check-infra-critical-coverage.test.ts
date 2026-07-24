import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeLcovPath,
  collectActualPercentages,
  compareToBaseline,
  findMissingRegistryFiles,
  type LcovFileTotals,
  metricPct,
  parseLcovPerFile,
  pctForFile,
} from "../../../scripts/quality/check-infra-critical-coverage";
import type { CriticalPathEntry } from "../../../scripts/quality/infra-critical-paths";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Issue #2758: infrastructure high-risk ファイル限定の coverage ratchet の純粋部分を pin する。
 * jscpd baseline ratchet (check-duplication.test.ts) と同じ方針 — 100% を強制せず、
 * baseline からの後退だけを検出する。
 */

function fileTotals(overrides: Partial<LcovFileTotals> = {}): LcovFileTotals {
  return {
    lines: { found: 10, hit: 10 },
    functions: { found: 5, hit: 5 },
    branches: { found: 4, hit: 4 },
    ...overrides,
  };
}

describe("parseLcovPerFile", () => {
  it("should split totals per SF: record", () => {
    const lcov = [
      "TN:",
      "SF:lib/a.ts",
      "FNF:2",
      "FNH:1",
      "LF:10",
      "LH:8",
      "BRF:4",
      "BRH:2",
      "end_of_record",
      "SF:lib/b.ts",
      "FNF:3",
      "FNH:3",
      "LF:5",
      "LH:5",
      "BRF:0",
      "BRH:0",
      "end_of_record",
    ].join("\n");

    const result = parseLcovPerFile(lcov);
    expect(result["lib/a.ts"]).toEqual({
      lines: { found: 10, hit: 8 },
      functions: { found: 2, hit: 1 },
      branches: { found: 4, hit: 2 },
    });
    expect(result["lib/b.ts"]).toEqual({
      lines: { found: 5, hit: 5 },
      functions: { found: 3, hit: 3 },
      branches: { found: 0, hit: 0 },
    });
  });

  it("should sum multiple records for the same SF path", () => {
    const lcov = [
      "SF:lib/a.ts",
      "LF:10",
      "LH:5",
      "end_of_record",
      "SF:lib/a.ts",
      "LF:10",
      "LH:5",
      "end_of_record",
    ].join("\n");

    const result = parseLcovPerFile(lcov);
    expect(result["lib/a.ts"]?.lines).toEqual({ found: 20, hit: 10 });
  });

  it("should ignore metric lines outside of any SF: record", () => {
    const lcov = ["LF:10", "LH:10", "SF:lib/a.ts", "LF:2", "LH:1", "end_of_record"].join("\n");
    const result = parseLcovPerFile(lcov);
    expect(Object.keys(result)).toEqual(["lib/a.ts"]);
    expect(result["lib/a.ts"]?.lines).toEqual({ found: 2, hit: 1 });
  });
});

describe("metricPct", () => {
  it("should treat found===0 as 100%", () => {
    expect(metricPct({ found: 0, hit: 0 })).toBe(100);
  });

  it("should round to 2 decimal places", () => {
    expect(metricPct({ found: 3, hit: 1 })).toBeCloseTo(33.33, 2);
  });
});

describe("pctForFile", () => {
  it("should compute lines/functions/branches percentages independently", () => {
    const pct = pctForFile(
      fileTotals({
        lines: { found: 10, hit: 5 },
        functions: { found: 4, hit: 4 },
        branches: { found: 8, hit: 2 },
      }),
    );
    expect(pct).toEqual({ lines: 50, functions: 100, branches: 25 });
  });
});

describe("canonicalizeLcovPath", () => {
  it("should prepend infrastructure/ to a workspace-relative SF path", () => {
    expect(canonicalizeLcovPath("lib/problem-deploy/handlers/shared/auth-wiring.ts")).toBe(
      "infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts",
    );
  });

  it("should leave an already repo-root-relative SF path unchanged", () => {
    expect(
      canonicalizeLcovPath("infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts"),
    ).toBe("infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts");
  });
});

describe("collectActualPercentages", () => {
  const registry: readonly CriticalPathEntry[] = [
    { path: "infrastructure/lib/a.ts", category: "auth-boundary" },
    { path: "infrastructure/lib/missing.ts", category: "scoring" },
  ];

  it("should resolve registry entries against canonicalized lcov keys", () => {
    const perFile: Record<string, LcovFileTotals> = {
      "lib/a.ts": fileTotals({ lines: { found: 10, hit: 10 } }),
    };
    const { percentages, missingFromLcov } = collectActualPercentages(perFile, registry);
    expect(percentages["infrastructure/lib/a.ts"]).toEqual({
      lines: 100,
      functions: 100,
      branches: 100,
    });
    expect(missingFromLcov).toEqual(["infrastructure/lib/missing.ts"]);
  });

  it("should report every registry entry absent from lcov, not just the first", () => {
    const { percentages, missingFromLcov } = collectActualPercentages({}, registry);
    expect(percentages).toEqual({});
    expect(missingFromLcov).toEqual(["infrastructure/lib/a.ts", "infrastructure/lib/missing.ts"]);
  });
});

describe("compareToBaseline", () => {
  it("should flag a metric that dropped below baseline beyond the epsilon", () => {
    const { regressions, improvements } = compareToBaseline(
      { "infrastructure/lib/a.ts": { lines: 90, functions: 100, branches: 80 } },
      { "infrastructure/lib/a.ts": { lines: 95, functions: 100, branches: 80 } },
    );
    expect(regressions).toEqual([
      { path: "infrastructure/lib/a.ts", metric: "lines", baseline: 95, actual: 90 },
    ]);
    expect(improvements).toEqual([]);
  });

  it("should not flag a float-noise difference within the epsilon", () => {
    const { regressions, improvements } = compareToBaseline(
      { "infrastructure/lib/a.ts": { lines: 94.995, functions: 100, branches: 80 } },
      { "infrastructure/lib/a.ts": { lines: 95, functions: 100, branches: 80 } },
    );
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([]);
  });

  it("should treat a brand-new registry entry as a 0% baseline (never a regression)", () => {
    const { regressions, improvements } = compareToBaseline(
      { "infrastructure/lib/new.ts": { lines: 42, functions: 10, branches: 5 } },
      {},
    );
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { path: "infrastructure/lib/new.ts", metric: "lines", baseline: 0, actual: 42 },
      { path: "infrastructure/lib/new.ts", metric: "functions", baseline: 0, actual: 10 },
      { path: "infrastructure/lib/new.ts", metric: "branches", baseline: 0, actual: 5 },
    ]);
  });

  it("should report an improvement when a metric rises above baseline beyond the epsilon", () => {
    const { regressions, improvements } = compareToBaseline(
      { "infrastructure/lib/a.ts": { lines: 100, functions: 100, branches: 100 } },
      { "infrastructure/lib/a.ts": { lines: 90, functions: 100, branches: 100 } },
    );
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { path: "infrastructure/lib/a.ts", metric: "lines", baseline: 90, actual: 100 },
    ]);
  });
});

describe("findMissingRegistryFiles", () => {
  it("should return registry paths that do not exist on disk", () => {
    const registry: readonly CriticalPathEntry[] = [
      {
        path: "infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts",
        category: "auth-boundary",
      },
      { path: "infrastructure/lib/does/not/exist.ts", category: "scoring" },
    ];
    const missing = findMissingRegistryFiles(registry, REPO_ROOT);
    expect(missing).toEqual(["infrastructure/lib/does/not/exist.ts"]);
  });

  it("should return an empty array when every entry exists", () => {
    const registry: readonly CriticalPathEntry[] = [
      {
        path: "infrastructure/lib/problem-deploy/handlers/shared/auth-wiring.ts",
        category: "auth-boundary",
      },
    ];
    const missing = findMissingRegistryFiles(registry, REPO_ROOT);
    expect(missing).toEqual([]);
  });
});
