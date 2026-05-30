import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeamScoreEvents } from "../../src/api/events-client";
import { computeRanking, TeamRankingPanel } from "../../src/components/TeamRankingPanel";

vi.mock("../../src/i18n", () => ({ useT: () => (k: string) => k }));

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

  it("should tie-break two event-less teams (lastUpdate undefined) at equal rank", () => {
    // 両者 0pt + events 無し → tie-break で a/b とも lastUpdateMs undefined (?? +Infinity 分岐)。
    const rows = computeRanking([team("a", "Alpha", []), team("b", "Bravo", [])]);
    expect(rows.every((r) => r.totalScore === 0)).toBe(true);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(1); // 同点同順位
  });
});

describe("TeamRankingPanel (component)", () => {
  it("should render nothing when there are no teams", () => {
    const { container } = render(<TeamRankingPanel teams={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should render rank badges (1=green / 2-3=blue / 4+=plain), names, scores and last-update", () => {
    const at = "2026-06-01T12:34:00Z";
    render(
      <TeamRankingPanel
        teams={[
          team("a", "Alpha", [{ points: 30, occurredAt: at }]),
          team("b", "Bravo", [{ points: 20, occurredAt: at }]),
          team("c", "Charlie", [{ points: 10, occurredAt: at }]),
          team("d", "Delta", []), // 0 pt / イベント無し → lastUpdate "—"
        ]}
      />,
    );
    // rank セル: 1 / 2 / 3 / 4 (1=green badge, 2-3=blue badge, 4=plain Box)。
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    // team 名 (code) + score。
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Delta")).toBeInTheDocument();
    expect(screen.getByText("30 pt")).toBeInTheDocument();
    expect(screen.getByText("0 pt")).toBeInTheDocument();
    // events 無しの team は lastUpdate が "—"。
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
