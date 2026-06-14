import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LeaderboardScoreEventsResponse,
  TeamScoreEvents,
  TeamScoreEventView,
} from "../api/portal-client";

/**
 * ScoreTimelineChart (全 team 累積スコア multi-series LineChart) の loading / error / empty /
 * 描画分岐と、 自チーム強調 + rival 色巡回 + locale 別 tick formatter を pin する。 純粋関数
 * buildCumulativePoints / toScoreTimelineLoadError は直接 unit-test。 getLeaderboardScoreEvents を
 * mock し、 locale は useI18n mock で固定する。
 */
const { mockGet, mockLocale } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockLocale: { value: "en" },
}));

vi.mock("../i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
  useI18n: () => ({ locale: mockLocale.value, setLocale: vi.fn(), t: (k: string) => k }),
}));
vi.mock("../api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/portal-client")>();
  return { ...actual, getLeaderboardScoreEvents: mockGet };
});

const { ScoreTimelineChart, buildCumulativePoints, toScoreTimelineLoadError } = await import(
  "./ScoreTimelineChart"
);

const event = (over: Partial<TeamScoreEventView> = {}): TeamScoreEventView => ({
  jobId: "job-1",
  problemId: "p",
  source: "flag",
  points: 10,
  result: "ok",
  occurredAt: "2026-05-22T12:00:00Z",
  ...over,
});

const team = (over: Partial<TeamScoreEvents> = {}): TeamScoreEvents => ({
  teamId: "t1",
  teamName: "Team One",
  isMyTeam: false,
  events: [],
  ...over,
});

const response = (teams: TeamScoreEvents[]): LeaderboardScoreEventsResponse => ({
  eventId: "ev-1",
  teams,
});

const renderChart = () =>
  render(<ScoreTimelineChart apiBaseUrl="https://api.example.com" sessionToken="team-key" />);

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

beforeEach(() => {
  mockGet.mockReset();
  mockLocale.value = "en";
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("pure helpers", () => {
  it("should accumulate points and skip unparseable timestamps", () => {
    const points = buildCumulativePoints(
      team({
        events: [
          event({ points: 10, occurredAt: "2026-05-22T12:00:00Z" }),
          event({ points: 5, occurredAt: "not-a-date" }), // skipped
          event({ points: 20, occurredAt: "2026-05-22T13:00:00Z" }),
        ],
      }),
    );
    // 無効分は y には積まれるが point は追加されない → 2 点、 y は 10 と 35。
    expect(points.map((p) => p.y)).toEqual([10, 35]);
  });

  it("should return an empty series for a team with no events", () => {
    expect(buildCumulativePoints(team({ events: [] }))).toEqual([]);
  });

  it("should map an AbortError to skip", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(toScoreTimelineLoadError(err)).toEqual({ kind: "skip" });
  });

  it("should map a generic Error to an error result", () => {
    expect(toScoreTimelineLoadError(new Error("boom"))).toEqual({ kind: "error", message: "boom" });
  });

  it("should stringify a non-Error rejection", () => {
    expect(toScoreTimelineLoadError("nope")).toEqual({ kind: "error", message: "nope" });
  });
});

describe("ScoreTimelineChart", () => {
  it("should show the loading state before the first fetch resolves", () => {
    mockGet.mockReturnValue(new Promise(() => undefined)); // never resolves
    renderChart();
    expect(screen.getByText("score_timeline.loading")).toBeInTheDocument();
  });

  it("should stay loading when the API returns no data (skip)", async () => {
    mockGet.mockResolvedValue(undefined);
    renderChart();
    // skip → setData されないので loading のまま。 fetch は呼ばれる。
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText("score_timeline.loading")).toBeInTheDocument();
  });

  it("should show an error state on fetch failure", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    renderChart();
    expect(await screen.findByText(/score_timeline\.fetch_failed/)).toBeInTheDocument();
  });

  it("should show the empty state when no team has any events", async () => {
    mockGet.mockResolvedValue(response([team({ isMyTeam: true, events: [] })]));
    renderChart();
    expect(await screen.findByText("score_timeline.empty_body")).toBeInTheDocument();
  });

  it("should render the multi-team chart with my-team emphasis and rival colors", async () => {
    mockGet.mockResolvedValue(
      response([
        team({
          teamId: "rival-a",
          teamName: "Rival A",
          isMyTeam: false,
          events: [event({ points: 10 }), event({ points: 5, occurredAt: "2026-05-22T13:00:00Z" })],
        }),
        team({
          teamId: "mine",
          teamName: "My Team",
          isMyTeam: true,
          events: [event({ points: 30 })],
        }),
        team({ teamId: "rival-b", teamName: "Rival B", isMyTeam: false, events: [event()] }),
      ]),
    );
    renderChart();
    expect(await screen.findByText(/score_timeline\.header_description/)).toBeInTheDocument();
    // 自チームは you_suffix、 rival は素の teamName。
    expect(screen.getByText(/score_timeline\.you_suffix/)).toBeInTheDocument();
  });

  it("should not poll the heavy score-events endpoint every 30s by default", async () => {
    mockGet.mockResolvedValue(response([team({ isMyTeam: true, events: [] })]));
    renderChart();
    expect(await screen.findByText("score_timeline.empty_body")).toBeInTheDocument();
    mockGet.mockClear();

    vi.useFakeTimers();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockGet).not.toHaveBeenCalled();
  });

  it("should refresh manually and poll only after auto refresh is enabled", async () => {
    mockGet.mockResolvedValue(response([team({ isMyTeam: true, events: [] })]));
    renderChart();
    expect(await screen.findByText("score_timeline.empty_body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "score_timeline.refresh_latest" }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("score_timeline.auto_refresh_label"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));

    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it("should share an in-flight refresh instead of issuing duplicate timeline reads", async () => {
    let resolveFetch: (value: LeaderboardScoreEventsResponse) => void = () => undefined;
    mockGet.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    renderChart();
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "score_timeline.refresh_latest" }));
    fireEvent.click(screen.getByRole("button", { name: "score_timeline.refresh_latest" }));

    expect(mockGet).toHaveBeenCalledTimes(1);
    resolveFetch(response([team({ isMyTeam: true, events: [] })]));
    expect(await screen.findByText("score_timeline.empty_body")).toBeInTheDocument();
  });

  it("should render with the ja locale tick formatter", async () => {
    mockLocale.value = "ja";
    mockGet.mockResolvedValue(response([team({ isMyTeam: true, events: [event()] })]));
    renderChart();
    expect(await screen.findByText(/score_timeline\.header_description/)).toBeInTheDocument();
  });

  it("should fall back to a default domain when all events have invalid timestamps", async () => {
    mockGet.mockResolvedValue(
      response([team({ isMyTeam: true, events: [event({ occurredAt: "not-a-date" })] })]),
    );
    renderChart();
    // totalEvents>0 だが point は空 → allTs/allY 空の fallback を踏みつつ chart は render。
    expect(await screen.findByText(/score_timeline\.header_description/)).toBeInTheDocument();
  });

  it("should skip the fetch when the session token is empty", async () => {
    render(<ScoreTimelineChart apiBaseUrl="https://api.example.com" sessionToken="" />);
    // !sessionToken → fetchScoreTimelineData は skip を返し getLeaderboardScoreEvents を呼ばない。
    expect(screen.getByText("score_timeline.loading")).toBeInTheDocument();
    await waitFor(() => expect(mockGet).not.toHaveBeenCalled());
  });
});
