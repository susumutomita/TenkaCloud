import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * HomePage の render 分岐: error / loading / dashboard (TeamScorePanel + quick-link →
 * /problems) / no-problems EmptyState (→ /scoreboard) / 長い team 名 truncate / teamName
 * fallback / rank "—"。 共有 hook と子 component (NextActionHero / ScoreTimelineChart /
 * design-system) を mock して HomePage 自身の分岐に集中する。
 */
const { mockAuth, mockIsMock, mockTeamView, mockNavigate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockIsMock: vi.fn(),
  mockTeamView: vi.fn(),
  mockNavigate: vi.fn(),
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock("../../src/components/NextActionHero", () => ({ NextActionHero: () => null }));
vi.mock("../../src/components/ScoreTimelineChart", () => ({
  ScoreTimelineChart: () => <div data-testid="timeline">chart</div>,
}));
vi.mock("../../src/components/design-system", () => ({
  ErrorState: ({ hint }: { hint: string }) => <div>error:{hint}</div>,
  LoadingState: ({ label }: { label: string }) => <div>loading:{label}</div>,
  EmptyState: ({ primaryAction }: { primaryAction: { label: string; onClick: () => void } }) => (
    <button type="button" onClick={primaryAction.onClick}>
      {primaryAction.label}
    </button>
  ),
}));

const { HomePage } = await import("../../src/pages/Home");
const config = { eventTitle: "Spring Cup", apiBaseUrl: "https://api.example.com" } as AppConfig;

const problem = {
  problemId: "p1",
  jobId: "job-1",
  status: "COMPLETE",
  score: 100,
  scoring: { kind: "flag", flagSubmitted: true },
};
// 非 flag (Battle uptime) 問題: 「解いた」 判定は score > 0 (TeamScorePanel の completed 集計分岐)。
const uptimeProblem = {
  problemId: "p2",
  jobId: "job-2",
  status: "COMPLETE",
  score: 50,
  scoring: { kind: "uptime" },
};
const viewWith = (problems: unknown[], teamName = "Alpha") =>
  ({ team: { teamName }, problems }) as never;

afterEach(() => vi.clearAllMocks());

describe("HomePage", () => {
  it("should show the error state and fall back to (unknown) team name", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: null });
    mockTeamView.mockReturnValue({ error: "boom" });
    const { container } = render(<HomePage config={config} />);
    expect(screen.getByText("error:boom")).toBeInTheDocument();
    expect(container.textContent).toContain("(unknown)");
  });

  it("should show the loading state and fall back to the session team name", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: { teamName: "FromSession" } });
    mockTeamView.mockReturnValue({});
    const { container } = render(<HomePage config={config} />);
    expect(screen.getByText("loading:app.loading")).toBeInTheDocument();
    expect(container.textContent).toContain("FromSession");
  });

  it("should render the dashboard (score panel, timeline, quick-link → /problems)", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: { sessionToken: "tok", teamName: "Alpha" } });
    mockTeamView.mockReturnValue({
      view: viewWith([problem, uptimeProblem]),
      leaderboard: { entries: [{ isMyTeam: true, rank: 1 }] },
    });
    const { container } = render(<HomePage config={config} />);
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
    expect(container.textContent).toContain("home.team_score_header");
    expect(container.textContent).toContain("1 / 1"); // rank
    fireEvent.click(screen.getByRole("button", { name: "home.quests_quick_link_button" }));
    expect(mockNavigate).toHaveBeenCalledWith("/problems");
  });

  it("should show '—' for rank when the team is not on the leaderboard", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: { sessionToken: "tok", teamName: "Alpha" } });
    mockTeamView.mockReturnValue({ view: viewWith([problem]), leaderboard: { entries: [] } });
    const { container } = render(<HomePage config={config} />);
    expect(container.textContent).toContain("home.rank_label");
    // myEntry 不在 → rankValue "—"。
    expect(container.textContent).toContain("—");
  });

  it("should show the no-problems empty state with a /scoreboard action", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: { sessionToken: "tok", teamName: "Alpha" } });
    mockTeamView.mockReturnValue({ view: viewWith([]), leaderboard: null });
    render(<HomePage config={config} />);
    fireEvent.click(screen.getByRole("button", { name: "home.quests_quick_link_button" }));
    expect(mockNavigate).toHaveBeenCalledWith("/scoreboard");
  });

  it("should truncate an over-long team name in the welcome header", () => {
    mockIsMock.mockReturnValue(false);
    mockAuth.mockReturnValue({ session: { sessionToken: "tok" } });
    const longName = "X".repeat(30);
    mockTeamView.mockReturnValue({ view: viewWith([problem], longName), leaderboard: null });
    const { container } = render(<HomePage config={config} />);
    // 24 文字 + "…"。 元の 30 文字フルネームは出ない。
    expect(container.textContent).toContain(`${"X".repeat(24)}…`);
    expect(container.textContent).not.toContain("X".repeat(30));
  });
});
