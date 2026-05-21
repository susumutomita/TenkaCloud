import { describe, expect, it } from "vitest";
import type { TeamScoreEvents } from "../../src/api/events-client";
import { computeRanking } from "../../src/components/TeamRankingPanel";

/**
 * Issue #1071: チーム順位計算の pure logic を pin。 events.points の合計を team 別に取り、
 * 降順 sort + 標準 tie-break (= 最終 update 早い方が上位) + 同点同順位を保証する。
 */
function team(
  teamId: string,
  teamName: string,
  events: ReadonlyArray<{ points: number; occurredAt: string }>,
): TeamScoreEvents {
  return {
    teamId,
    teamName,
    events: events.map((e, i) => ({
      jobId: `${teamId}-${i}`,
      problemId: "hello-world",
      source: "uptime",
      points: e.points,
      result: "ok",
      occurredAt: e.occurredAt,
    })),
  };
}

describe("computeRanking (Issue #1071)", () => {
  it("should assign rank in descending score order", () => {
    const rows = computeRanking([
      team("t-1", "alpha", [{ points: 100, occurredAt: "2026-05-19T10:00:00.000Z" }]),
      team("t-2", "beta", [{ points: 300, occurredAt: "2026-05-19T10:00:00.000Z" }]),
      team("t-3", "gamma", [{ points: 200, occurredAt: "2026-05-19T10:00:00.000Z" }]),
    ]);
    expect(rows.map((r) => [r.rank, r.teamName])).toEqual([
      [1, "beta"],
      [2, "gamma"],
      [3, "alpha"],
    ]);
  });

  it("should rank ties by earliest last update first (= standard tie-break)", () => {
    const rows = computeRanking([
      team("t-1", "later", [{ points: 100, occurredAt: "2026-05-19T10:05:00.000Z" }]),
      team("t-2", "earlier", [{ points: 100, occurredAt: "2026-05-19T10:00:00.000Z" }]),
    ]);
    expect(rows[0].teamName).toBe("earlier");
    expect(rows[1].teamName).toBe("later");
  });

  it("should assign equal ranks to ties (= skip like 1, 1, 3)", () => {
    const rows = computeRanking([
      team("t-1", "a", [{ points: 200, occurredAt: "2026-05-19T10:00:00.000Z" }]),
      team("t-2", "b", [{ points: 200, occurredAt: "2026-05-19T10:00:00.000Z" }]),
      team("t-3", "c", [{ points: 100, occurredAt: "2026-05-19T10:00:00.000Z" }]),
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it("should include teams with zero events at 0 pt in the ranking", () => {
    const rows = computeRanking([
      team("t-1", "no-events", []),
      team("t-2", "scored", [{ points: 50, occurredAt: "2026-05-19T10:00:00.000Z" }]),
    ]);
    expect(rows.map((r) => [r.rank, r.teamName, r.totalScore])).toEqual([
      [1, "scored", 50],
      [2, "no-events", 0],
    ]);
  });

  it("should sum multiple events", () => {
    const rows = computeRanking([
      team("t-1", "multi", [
        { points: 30, occurredAt: "2026-05-19T10:00:00.000Z" },
        { points: 50, occurredAt: "2026-05-19T10:05:00.000Z" },
        { points: -10, occurredAt: "2026-05-19T10:10:00.000Z" },
      ]),
    ]);
    expect(rows[0].totalScore).toBe(70);
  });
});
