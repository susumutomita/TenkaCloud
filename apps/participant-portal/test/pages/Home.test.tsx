import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * HomePage: welcome header (teamName fallback + truncate) / loading / error / NextActionHero /
 * TeamScorePanel / ScoreTimelineChart の表示条件 / quests quick-link navigate / 空状態 EmptyState を
 * pin する。 共有 hook は mock、 子 (NextActionHero/ScoreTimelineChart/TeamScorePanel) は stub、
 * design-system は実物。
 */
const { mockAuth, mockTeamView, mockIsMock, mockNav, mockHeroProps, mockBuildCourseTracks } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockTeamView: vi.fn(),
    mockIsMock: vi.fn(),
    mockNav: vi.fn(),
    mockHeroProps: vi.fn(),
    mockBuildCourseTracks: vi.fn(),
  }));

vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;
  return { useT: () => t };
});
vi.mock("../../src/components/NextActionHero", () => ({
  NextActionHero: ({ preferredNextProblemId }: { preferredNextProblemId?: string }) => {
    mockHeroProps(preferredNextProblemId);
    return <div data-testid="next-action" />;
  },
}));
// 講座トラックの中身は course-track / problems 側の test が pin する。 ここで見たいのは
// 「HomePage がどのトラックの推薦を hero に渡すか」 だけなので、 実カタログ (= import.meta.glob
// 経由の 71 問) は挟まず、 トラック構築を stub して分岐だけを test する。
vi.mock("../../src/data/problems", () => ({ listProblemCatalog: () => [] }));
vi.mock("../../src/data/course-track", () => ({
  buildCourseTracks: mockBuildCourseTracks,
  toProblemProgress: (problems: readonly unknown[]) => problems,
}));
vi.mock("../../src/components/ScoreTimelineChart", () => ({
  ScoreTimelineChart: () => <div data-testid="score-chart" />,
}));
vi.mock("../../src/pages/TeamScorePanel", () => ({
  TeamScorePanel: () => <div data-testid="team-score-panel" />,
}));

const { HomePage } = await import("../../src/pages/Home");

const config = { eventTitle: "Test Event", apiBaseUrl: "https://api.example.com" } as AppConfig;
// biome-ignore lint/suspicious/noExplicitAny: 最小 view fixture。
const view = (over: Record<string, any> = {}): any => ({
  team: { teamName: "Alpha", teamNameSetByCompetitor: true },
  problems: [{ jobId: "j1", problemId: "p1", score: 10 }],
  ...over,
});
const tv = (over: Record<string, unknown> = {}) => ({
  view: null,
  error: null,
  leaderboard: null,
  ...over,
});
const renderHome = () => render(<HomePage config={config} />);

beforeEach(() => {
  mockAuth.mockReturnValue({ session: { sessionToken: "tok", teamName: "SessionTeam" } });
  mockIsMock.mockReturnValue(false);
  mockNav.mockClear();
  mockTeamView.mockReturnValue(tv({ view: view() }));
  mockBuildCourseTracks.mockReturnValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("HomePage", () => {
  it("should greet the team and show the dashboard panels when a view is present", () => {
    renderHome();
    expect(screen.getByText('home.welcome|{"teamName":"Alpha"}')).toBeInTheDocument();
    expect(screen.getByTestId("next-action")).toBeInTheDocument();
    expect(screen.getByTestId("team-score-panel")).toBeInTheDocument();
    expect(screen.getByTestId("score-chart")).toBeInTheDocument(); // backend + session + problems
  });

  it("should show the loading state and fall the team name back to the session", () => {
    mockTeamView.mockReturnValue(tv({ view: null, error: null }));
    renderHome();
    expect(screen.getByText("app.loading")).toBeInTheDocument();
    expect(screen.getByText('home.welcome|{"teamName":"SessionTeam"}')).toBeInTheDocument();
  });

  it("should fall back to (unknown) when neither view nor session has a team name", () => {
    mockAuth.mockReturnValue({ session: null });
    mockTeamView.mockReturnValue(tv({ view: null }));
    renderHome();
    expect(screen.getByText('home.welcome|{"teamName":"(unknown)"}')).toBeInTheDocument();
  });

  it("should truncate an overly long team name", () => {
    mockTeamView.mockReturnValue(tv({ view: view({ team: { teamName: "x".repeat(30) } }) }));
    renderHome();
    expect(screen.getByText(`home.welcome|{"teamName":"${"x".repeat(24)}…"}`)).toBeInTheDocument();
  });

  it("should show the error state", () => {
    mockTeamView.mockReturnValue(tv({ view: null, error: "load boom" }));
    renderHome();
    expect(screen.getByText("app.fetch_status_failed")).toBeInTheDocument();
    expect(screen.getByText("load boom")).toBeInTheDocument();
  });

  it("should navigate to /problems from the quests quick link", () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "home.quests_quick_link_button" }));
    expect(mockNav).toHaveBeenCalledWith("/problems");
  });

  it("should hide the score chart in mock mode", () => {
    mockIsMock.mockReturnValue(true);
    mockTeamView.mockReturnValue(tv({ view: view() }));
    renderHome();
    expect(screen.queryByTestId("score-chart")).not.toBeInTheDocument();
    expect(screen.getByTestId("team-score-panel")).toBeInTheDocument();
  });

  it("should render the empty state (and navigate to /scoreboard) when there are no problems", () => {
    mockTeamView.mockReturnValue(tv({ view: view({ problems: [] }) }));
    renderHome();
    expect(screen.getByText("home.no_problems_body")).toBeInTheDocument();
    expect(screen.queryByTestId("score-chart")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "home.quests_quick_link_button" }));
    expect(mockNav).toHaveBeenCalledWith("/scoreboard");
  });
});

/**
 * [#2882] 「次にやること」 が講座トラックの順に従うこと。 推薦を組むのは local だけ
 * (`showsCourseTracks`) で、 mock (= LP から辿る公開デモ) と real (= 本番イベント) では
 * hero はカタログ既定の順のままにする — その 2 つは受講者ごとの学習経路を持たないから。
 */
describe("HomePage course-track recommendation", () => {
  const localConfig = { ...config, cloudMode: "local" } as AppConfig;
  // biome-ignore lint/suspicious/noExplicitAny: 最小 track fixture (recommendedNext の有無だけ見る)。
  const track = (trackId: string, recommendedNext?: string): any => ({
    trackId,
    chapters: [],
    totalProblems: 0,
    solvedProblems: 0,
    totalCheckpoints: 0,
    solvedCheckpoints: 0,
    recommendedNext: recommendedNext === undefined ? undefined : { problemId: recommendedNext },
  });

  it("should hand the hero the first track that still recommends a problem", () => {
    mockBuildCourseTracks.mockReturnValue([track("finished"), track("ac26", "what-is-tenkacloud")]);
    render(<HomePage config={localConfig} />);
    expect(mockHeroProps).toHaveBeenCalledWith("what-is-tenkacloud");
  });

  it("should hand the hero no recommendation once every track is finished", () => {
    mockBuildCourseTracks.mockReturnValue([track("finished")]);
    render(<HomePage config={localConfig} />);
    expect(mockHeroProps).toHaveBeenCalledWith(undefined);
  });

  it("should build the tracks with empty progress while the team view is still loading", () => {
    mockTeamView.mockReturnValue(tv({ view: null }));
    render(<HomePage config={localConfig} />);
    expect(mockBuildCourseTracks).toHaveBeenCalledWith([], []);
  });

  it("should not consult the course tracks outside local mode", () => {
    renderHome(); // 既定 config は cloudMode 未設定 (= local ではない)
    expect(mockBuildCourseTracks).not.toHaveBeenCalled();
    expect(mockHeroProps).toHaveBeenCalledWith(undefined);
  });
});
