import { describe, expect, it } from "vitest";
import type { ScoreEventView } from "../../src/api/portal-client";
import { buildCumulativeSeries, chartXDomain } from "../../src/lib/score-events-chart";

/**
 * 累積スコア系列の組み立てと x 軸 domain 導出を pin する。 ScoreEventsPage から切り出した
 * 純関数なので、 sort・同値 timestamp・無効 timestamp skip・空入力の各分岐を直接踏む。
 */
const ev = (over: Partial<ScoreEventView>): ScoreEventView => ({
  jobId: "job-1",
  problemId: "p",
  source: "flag",
  points: 10,
  result: "ok",
  occurredAt: "2026-05-22T13:00:00Z",
  ...over,
});

describe("buildCumulativeSeries", () => {
  it("should return an empty series for no entries", () => {
    expect(buildCumulativeSeries([])).toEqual([]);
  });

  it("should accumulate points in occurredAt ascending order regardless of input order", () => {
    const series = buildCumulativeSeries([
      ev({ points: 30, occurredAt: "2026-05-22T14:00:00Z" }),
      ev({ points: 10, occurredAt: "2026-05-22T12:00:00Z" }),
      ev({ points: 20, occurredAt: "2026-05-22T13:00:00Z" }),
    ]);
    expect(series.map((p) => p.y)).toEqual([10, 30, 60]);
    expect(series.map((p) => p.x.toISOString())).toEqual([
      "2026-05-22T12:00:00.000Z",
      "2026-05-22T13:00:00.000Z",
      "2026-05-22T14:00:00.000Z",
    ]);
  });

  it("should keep equal-timestamp entries (sort comparator === 0 branch)", () => {
    const series = buildCumulativeSeries([
      ev({ points: 5, occurredAt: "2026-05-22T13:00:00Z" }),
      ev({ points: 7, occurredAt: "2026-05-22T13:00:00Z" }),
    ]);
    expect(series.map((p) => p.y)).toEqual([5, 12]);
  });

  it("should add points but skip the point when occurredAt is unparseable", () => {
    const series = buildCumulativeSeries([
      ev({ points: 10, occurredAt: "2026-05-22T12:00:00Z" }),
      // 無効 timestamp → 累積には加算するが点は打たない (skip)。
      ev({ points: 25, occurredAt: "not-a-date" }),
      ev({ points: 5, occurredAt: "2026-05-22T14:00:00Z" }),
    ]);
    // not-a-date は sort で末尾寄りに行くが、 いずれにせよ点が打たれないことだけを保証する。
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.x.toISOString())).toEqual([
      "2026-05-22T12:00:00.000Z",
      "2026-05-22T14:00:00.000Z",
    ]);
  });
});

describe("chartXDomain", () => {
  it("should return undefined for an empty series (no silent now() fallback)", () => {
    expect(chartXDomain([])).toBeUndefined();
  });

  it("should return the first and last point timestamps", () => {
    const series = buildCumulativeSeries([
      ev({ points: 10, occurredAt: "2026-05-22T12:00:00Z" }),
      ev({ points: 5, occurredAt: "2026-05-22T15:00:00Z" }),
    ]);
    const domain = chartXDomain(series);
    expect(domain?.[0].toISOString()).toBe("2026-05-22T12:00:00.000Z");
    expect(domain?.[1].toISOString()).toBe("2026-05-22T15:00:00.000Z");
  });

  it("should return a single point as both ends of the domain", () => {
    const series = buildCumulativeSeries([ev({ occurredAt: "2026-05-22T12:00:00Z" })]);
    const domain = chartXDomain(series);
    expect(domain?.[0]).toBe(domain?.[1]);
  });
});
