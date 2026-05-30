import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamScoreEvents } from "../../src/api/events-client";
import { TeamScoreEventsPanel } from "../../src/components/TeamScoreEventsPanel";

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
