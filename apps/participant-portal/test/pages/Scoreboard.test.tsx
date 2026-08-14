import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

/**
 * ScoreboardPage の render 分岐: error / no-event / loading spinner / scoreboard freeze
 * (endsAt 有無) / 通常 table (自チーム強調 cell)。 共有 hook (useTeamView / useIsMock / useT)
 * を mock して各 state を駆動する。 専用 polling は持たない page なので state は注入で完結。
 */
const { mockTeamView, mockIsMock } = vi.hoisted(() => ({
  mockTeamView: vi.fn(),
  mockIsMock: vi.fn(),
}));
vi.mock("../../src/i18n", () => ({
  useLang: () => "en",
  useT: () => (key: string, params?: Readonly<Record<string, string | number>>) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}));
vi.mock("../../src/config-context", () => ({ useIsMock: mockIsMock }));
vi.mock("../../src/auth/TeamViewProvider", () => ({ useTeamView: mockTeamView }));

const { ScoreboardPage } = await import("../../src/pages/Scoreboard");

const config = { eventTitle: "Spring Cup" } as AppConfig;
const entries = [
  {
    rank: 1,
    teamName: "Alpha",
    score: 100,
    completedProblems: 2,
    totalProblems: 3,
    isMyTeam: true,
  },
  {
    rank: 2,
    teamName: "Bravo",
    score: 50,
    completedProblems: 1,
    totalProblems: 3,
    isMyTeam: false,
  },
];

afterEach(() => vi.clearAllMocks());

describe("ScoreboardPage", () => {
  it("should show an error alert when leaderboard polling failed", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue({ leaderboardError: "boom" });
    render(<ScoreboardPage config={config} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("app.fetch_status_failed")).toBeInTheDocument();
  });

  it("should show a no-event info alert", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue({ leaderboardNoEvent: true });
    render(<ScoreboardPage config={config} />);
    expect(screen.getByText("scoreboard.no_event_header")).toBeInTheDocument();
  });

  it("should show a loading spinner in backend mode while the leaderboard is unresolved", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue({});
    render(<ScoreboardPage config={config} />);
    expect(screen.getByText("app.loading")).toBeInTheDocument();
  });

  it("should not show the spinner in mock mode with no leaderboard", () => {
    mockIsMock.mockReturnValue(true);
    mockTeamView.mockReturnValue({});
    render(<ScoreboardPage config={config} />);
    expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
  });

  it("should show the frozen alert (with and without endsAt)", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue({
      leaderboard: { scoreboardFrozen: true, endsAt: "2026-05-21T12:00:00.000Z", entries: [] },
    });
    const a = render(<ScoreboardPage config={config} />);
    expect(a.getByText("scoreboard.frozen_header")).toBeInTheDocument();
    expect(a.container.textContent).toContain("scoreboard.frozen_ends_at_label");
    a.unmount();

    mockTeamView.mockReturnValue({ leaderboard: { scoreboardFrozen: true, entries: [] } });
    const b = render(<ScoreboardPage config={config} />);
    expect(b.getByText("scoreboard.frozen_header")).toBeInTheDocument();
    expect(b.container.textContent).not.toContain("scoreboard.frozen_ends_at_label");
  });

  it("should render the ranking table with the own-team row emphasized", () => {
    mockIsMock.mockReturnValue(false);
    mockTeamView.mockReturnValue({ leaderboard: { scoreboardFrozen: false, entries } });
    render(<ScoreboardPage config={config} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    // isMyTeam=true の行に「あなた」 suffix。
    expect(screen.getByText("scoreboard.you_suffix")).toBeInTheDocument();
    // entries_header に count が渡る。
    expect(screen.getByText(/scoreboard\.entries_header/)).toBeInTheDocument();
  });
});
