import { describe, expect, it } from "vitest";
import {
  GATED_WORKSPACES,
  isFullyCovered,
  isMetricFull,
  metricPct,
  parseLcovTotals,
} from "../../../scripts/check-coverage-gate";

/**
 * Issue #1424: coverage gate の lcov パーサ。 LF/LH・FNF/FNH・BRF/BRH を集計し、
 * found===hit を 100% と判定する。 複数 SF レコードの合算と、 branches 0 件 (= 100%) を pin。
 */
const FULL_LCOV = [
  "TN:",
  "SF:src/a.ts",
  "FNF:2",
  "FNH:2",
  "LF:10",
  "LH:10",
  "BRF:4",
  "BRH:4",
  "end_of_record",
  "SF:src/b.ts",
  "FNF:1",
  "FNH:1",
  "LF:5",
  "LH:5",
  "BRF:0",
  "BRH:0",
  "end_of_record",
].join("\n");

const PARTIAL_LCOV = [
  "SF:src/c.ts",
  "FNF:3",
  "FNH:3",
  "LF:20",
  "LH:20",
  "BRF:8",
  "BRH:6", // 2 branches uncovered
  "end_of_record",
].join("\n");

describe("parseLcovTotals", () => {
  it("should sum metrics across all SF records", () => {
    const t = parseLcovTotals(FULL_LCOV);
    expect(t.lines).toEqual({ found: 15, hit: 15 });
    expect(t.functions).toEqual({ found: 3, hit: 3 });
    expect(t.branches).toEqual({ found: 4, hit: 4 });
  });

  it("should ignore non-metric lines and unparseable numbers", () => {
    const t = parseLcovTotals("TN:\nSF:x\nDA:1,2\nLF:3\nLH:3\nend_of_record\nFNF:notnum");
    expect(t.lines).toEqual({ found: 3, hit: 3 });
    expect(t.functions).toEqual({ found: 0, hit: 0 });
  });
});

describe("isMetricFull / isFullyCovered", () => {
  it("should treat hit===found as full and found===0 as full", () => {
    expect(isMetricFull({ found: 4, hit: 4 })).toBe(true);
    expect(isMetricFull({ found: 0, hit: 0 })).toBe(true);
    expect(isMetricFull({ found: 8, hit: 6 })).toBe(false);
  });

  it("should pass a fully-covered lcov and fail a partial one", () => {
    expect(isFullyCovered(parseLcovTotals(FULL_LCOV))).toBe(true);
    expect(isFullyCovered(parseLcovTotals(PARTIAL_LCOV))).toBe(false);
  });
});

describe("metricPct", () => {
  it("should report a percentage and treat 0-found as 100", () => {
    expect(metricPct({ found: 8, hit: 6 })).toBe(75);
    expect(metricPct({ found: 0, hit: 0 })).toBe(100);
    expect(metricPct({ found: 10, hit: 10 })).toBe(100);
  });
});

describe("GATED_WORKSPACES", () => {
  it("should gate the three SPAs and the shared packages (not infrastructure)", () => {
    expect(GATED_WORKSPACES).toContain("apps/participant-portal");
    expect(GATED_WORKSPACES).toContain("packages/format");
    expect(GATED_WORKSPACES).not.toContain("infrastructure");
  });
});
