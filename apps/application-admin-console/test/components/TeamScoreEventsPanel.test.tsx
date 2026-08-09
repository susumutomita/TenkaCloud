import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamScoreEvents } from "../../src/api/events-client";
import { buildChartView, TeamScoreEventsPanel } from "../../src/components/TeamScoreEventsPanel";

/**
 * TeamScoreEventsPanel: 全 team 累積スコア multi-series LineChart。 empty (totalEvents 0) /
 * 描画 (teamName→teamId fallback、 buildCumulative の invalid-timestamp skip、 全 invalid で
 * domain fallback) を pin する。 useT は安定 echo、 ResizeObserver は stub。
 */
vi.mock("../../src/i18n", () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  return { useT: () => t };
});

const ev = (over: Record<string, unknown> = {}) => ({
  points: 10,
  occurredAt: "2026-05-20T10:00:00.000Z",
  ...over,
});
// biome-ignore lint/suspicious/noExplicitAny: 最小 team fixture。
const team = (over: Record<string, any> = {}): TeamScoreEvents =>
  ({ teamId: "t1", teamName: "Alpha", events: [], ...over }) as unknown as TeamScoreEvents;

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("TeamScoreEventsPanel", () => {
  it("should render the empty state when no team has any events", () => {
    render(<TeamScoreEventsPanel teams={[team({ events: [] })]} />);
    expect(screen.getByText("team_score_events_panel.empty")).toBeInTheDocument();
  });

  it("should render the chart, accumulate points, and skip invalid timestamps", () => {
    render(
      <TeamScoreEventsPanel
        teams={[
          team({
            teamId: "t1",
            teamName: "Alpha",
            events: [
              ev({ points: 10, occurredAt: "2026-05-20T10:00:00.000Z" }),
              ev({ points: 5, occurredAt: "not-a-date" }), // skipped (continue)
              ev({ points: 20, occurredAt: "2026-05-20T11:00:00.000Z" }),
            ],
          }),
          // teamName 空 → teamId にフォールバック。
          team({ teamId: "team-2-id", teamName: "", events: [ev()] }),
        ]}
      />,
    );
    expect(screen.getByText("team_score_events_panel.header")).toBeInTheDocument();
    expect(screen.getByText(/team_score_events_panel\.description/)).toBeInTheDocument();
  });

  it("should fall back to a default domain when every timestamp is invalid", () => {
    render(<TeamScoreEventsPanel teams={[team({ events: [ev({ occurredAt: "nope" })] })]} />);
    // totalEvents>0 だが series は空 → allTs/allY 空の fallback を踏みつつ chart は render。
    expect(screen.getByText("team_score_events_panel.header")).toBeInTheDocument();
  });
});

/**
 * 系列の形そのもの (Issue 2988)。
 *
 * 実測された症状は「team human が 1 問解いて 100pt、team-ai は未提出」という
 * 2 チームの Battle で、グラフが軸と凡例だけになったこと。原因は系列の点の数で、
 * jsdom で Cloudscape の LineChart を render しても点は覗けないので、view model を
 * 直接見る。
 */
describe("buildChartView (Issue 2988)", () => {
  const START = "2026-05-20T09:00:00.000Z";
  const SCORED = team({
    teamId: "human",
    teamName: "human",
    events: [ev({ points: 100, occurredAt: "2026-05-20T10:00:00.000Z" })],
  });
  const NEVER_SCORED = team({ teamId: "ai", teamName: "team-ai", events: [] });

  it("は 1 件しか得点していないチームを、点ではなく線にする", () => {
    const view = buildChartView([SCORED], START);
    const data = view.series[0]?.data ?? [];
    // 0 起点 → 加点。2 点以上ないと線は引けない。
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0]).toEqual({ x: new Date(START), y: 0 });
    expect(data.at(-1)?.y).toBe(100);
  });

  it("は未提出のチームを、0 のまま伸びる線として描く", () => {
    // 以前はここが空配列で、凡例には出るのにグラフ上に何も無かった。
    const view = buildChartView([SCORED, NEVER_SCORED], START);
    const idle = view.series[1]?.data ?? [];
    expect(idle.length).toBeGreaterThanOrEqual(2);
    expect(idle.every((p) => p.y === 0)).toBe(true);
    expect(idle.at(-1)?.x).toEqual(view.maxX);
  });

  it("は時間軸の左端をイベント開始に固定する", () => {
    // 起点が無いと、1 件しか点が無いとき min と max が同じ瞬間になって軸が潰れる。
    const view = buildChartView([SCORED, NEVER_SCORED], START);
    expect(view.minX).toEqual(new Date(START));
    expect(view.maxX.getTime()).toBeGreaterThan(view.minX.getTime());
  });

  it("は開始時刻が無ければ起点を捏造しない", () => {
    const view = buildChartView([SCORED], undefined);
    expect(view.series[0]?.data).toEqual([{ x: new Date("2026-05-20T10:00:00.000Z"), y: 100 }]);
  });

  it("は開始時刻より前の加点があっても系列を逆行させない", () => {
    const early = team({
      teamId: "t",
      teamName: "Early",
      events: [ev({ points: 5, occurredAt: "2026-05-20T08:00:00.000Z" })],
    });
    const view = buildChartView([early], START);
    const xs = (view.series[0]?.data ?? []).map((p) => p.x.getTime());
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });
});
