import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse, ParticipantTeamView } from "../../src/api/portal-client";
import type { AppConfig } from "../../src/config";
import type { LocaleCode } from "../../src/i18n";

/**
 * AppLayout: pure helper / utility builder (formatTopNavScore / formatTopNavRank /
 * isSupportedLocaleId / buildProfileMenuItems / handleProfileMenuClick / buildLocaleUtility /
 * buildScoreRankUtility / buildProfileUtility) と、 ShellLayout component の render
 * (session 有無 / cloudMode 別 offline alert / 未読 badge / sidenav navigate) を pin する。
 * 共有 hook と TeamViewProvider・CountdownTimer は mock。
 */
const { mockAuth, mockTeamView, mockNav, mockLocale, mockSetLocale } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTeamView: vi.fn(),
  mockNav: vi.fn(),
  mockLocale: { value: "en" as LocaleCode },
  mockSetLocale: vi.fn(),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => mockNav,
}));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockAuth }));
vi.mock("../../src/auth/TeamViewProvider", () => ({
  TeamViewProvider: ({ children }: { children: React.ReactNode }) => children,
  useTeamView: mockTeamView,
}));
vi.mock("../../src/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      locale: mockLocale.value,
      setLocale: mockSetLocale,
      t: (key: string, params?: Readonly<Record<string, string | number>>) =>
        params ? `${key}|${JSON.stringify(params)}` : key,
    }),
  };
});
vi.mock("../../src/components/CountdownTimer", () => ({ CountdownTimer: () => null }));

const {
  buildProfileMenuItems,
  formatTopNavRank,
  formatTopNavScore,
  handleProfileMenuClick,
  buildScoreRankUtility,
  buildProfileUtility,
  handleSideNavFollow,
  ShellLayout,
} = await import("../../src/components/AppLayout");

function teamView(scores: readonly number[]): ParticipantTeamView {
  return {
    team: { teamName: "Blue", teamNameSetByCompetitor: true },
    problems: scores.map((score, index) => ({
      jobId: `job-${index}`,
      problemId: `problem-${index}`,
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: 0,
      score,
      deployLog: { cursor: "0", entries: [] },
    })),
  } satisfies ParticipantTeamView;
}

function leaderboard(entries: LeaderboardResponse["entries"]): LeaderboardResponse {
  return { eventId: "event-1", entries } satisfies LeaderboardResponse;
}

// ── pure helpers (existing coverage, kept) ───────────────────────────────────
describe("AppLayout top navigation helpers", () => {
  it("should display the sum of fetched scores in backend mode", () => {
    expect(formatTopNavScore("backend", teamView([10, 15, -3]))).toBe("22 pt");
  });

  it("should display the score fallback when backend has not loaded or in mock mode", () => {
    expect(formatTopNavScore("backend", null)).toBe("…");
    expect(formatTopNavScore("dev-mock", teamView([10]))).toBe("—");
  });

  it("should display own team rank and total team count in backend mode", () => {
    expect(
      formatTopNavRank(
        "backend",
        leaderboard([
          {
            rank: 1,
            teamId: "team-a",
            teamName: "Blue",
            score: 100,
            completedProblems: 1,
            totalProblems: 2,
            isMyTeam: true,
          },
          {
            rank: 2,
            teamId: "team-b",
            teamName: "Red",
            score: 80,
            completedProblems: 1,
            totalProblems: 2,
            isMyTeam: false,
          },
        ]),
        false,
      ),
    ).toBe("1/2");
  });

  it("should display a state-appropriate fallback when rank is unavailable", () => {
    expect(formatTopNavRank("dev-mock", null, false)).toBe("—");
    expect(formatTopNavRank("backend", null, true)).toBe("—");
    expect(formatTopNavRank("backend", null, false)).toBe("…");
    expect(formatTopNavRank("backend", leaderboard([]), false)).toBe("…");
  });
});

describe("profile dropdown menu (Issue #1191)", () => {
  it("should list change_team_name before logout so the destructive action is visually last", () => {
    expect(buildProfileMenuItems((key) => `<${key}>`)).toEqual([
      { id: "change_team_name", text: "<nav.change_team_name>" },
      { id: "logout", text: "<nav.sign_out>" },
    ]);
  });

  it("should navigate to /setup when the change_team_name item is clicked", () => {
    const logout = vi.fn();
    const navigate = vi.fn();
    handleProfileMenuClick("change_team_name", { logout, navigate });
    expect(navigate).toHaveBeenCalledWith("/setup");
    expect(logout).not.toHaveBeenCalled();
  });

  it("should logout and navigate to /login when the logout item is clicked", () => {
    const logout = vi.fn();
    const navigate = vi.fn();
    handleProfileMenuClick("logout", { logout, navigate });
    expect(logout).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("should ignore unknown menu item ids without side effects", () => {
    const logout = vi.fn();
    const navigate = vi.fn();
    handleProfileMenuClick("does-not-exist", { logout, navigate });
    expect(logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ── utility builders (callbacks unit-tested directly) ────────────────────────
type MenuUtil = Extract<ReturnType<typeof buildProfileUtility>, { type: "menu-dropdown" }>;
type ButtonUtil = Extract<ReturnType<typeof buildScoreRankUtility>, { type: "button" }>;

describe("utility builders", () => {
  it("should build a score/rank button that navigates to /scoreboard", () => {
    const navigate = vi.fn();
    const u = buildScoreRankUtility("22 pt", "1/2", navigate) as ButtonUtil;
    expect(u.text).toContain("22 pt");
    expect(u.text).toContain("1/2");
    u.onClick?.({} as never);
    expect(navigate).toHaveBeenCalledWith("/scoreboard");
  });

  it("should build a profile dropdown that dispatches menu clicks", () => {
    const logout = vi.fn();
    const navigate = vi.fn();
    const u = buildProfileUtility("Blue", logout, navigate, (k) => k) as MenuUtil;
    expect(u.text).toBe("Blue");
    u.onItemClick?.({ detail: { id: "logout" } } as never);
    expect(logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("should navigate for internal links and defer to the browser for external ones", () => {
    const navigate = vi.fn();
    const preventDefault = vi.fn();
    handleSideNavFollow({ preventDefault, detail: { external: false, href: "/x" } }, navigate);
    expect(preventDefault).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/x");

    navigate.mockClear();
    preventDefault.mockClear();
    handleSideNavFollow(
      { preventDefault, detail: { external: true, href: "https://ext" } },
      navigate,
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ── ShellLayout component render ─────────────────────────────────────────────
const tv = (over: Record<string, unknown> = {}) => ({
  view: null,
  leaderboard: null,
  leaderboardNoEvent: false,
  unreadNotificationCount: 0,
  ...over,
});

const config = (over: Partial<AppConfig> = {}) =>
  ({
    apiBaseUrl: "https://api.example.com",
    eventTitle: "Test event",
    eventRegion: "ap-northeast-1",
    mode: "backend",
    cloudMode: "real",
    ...over,
  }) as AppConfig;

const renderShell = (configOver: Partial<AppConfig> = {}) =>
  render(
    <ShellLayout config={config(configOver)}>
      <div>child-content</div>
    </ShellLayout>,
  );

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
  mockNav.mockClear();
  mockSetLocale.mockClear();
  mockLocale.value = "en";
  mockAuth.mockReturnValue({ session: { teamName: "Blue" }, logout: vi.fn() });
  mockTeamView.mockReturnValue(tv({ view: teamView([10, 15]) }));
});

afterEach(() => vi.clearAllMocks());

describe("ShellLayout", () => {
  it("should render children and the team profile when signed in", () => {
    renderShell();
    expect(screen.getByText("child-content")).toBeInTheDocument();
    // profile utility text (TopNavigation は responsive で複数箇所に出す)
    expect(screen.getAllByText("Blue").length).toBeGreaterThan(0);
    expect(screen.queryByText("app.no_session")).not.toBeInTheDocument();
  });

  it("should show the no-session warning and only the locale switcher when signed out", () => {
    mockAuth.mockReturnValue({ session: null, logout: vi.fn() });
    renderShell();
    expect(screen.getByText("app.no_session")).toBeInTheDocument();
    expect(screen.getByText("child-content")).toBeInTheDocument();
    expect(screen.queryByText("Blue")).not.toBeInTheDocument();
  });

  it("should navigate via the side navigation onFollow handler", () => {
    renderShell();
    fireEvent.click(screen.getByText("nav.scoreboard"));
    expect(mockNav).toHaveBeenCalledWith("/scoreboard");
  });

  it("should not render an offline alert in real cloud mode", () => {
    renderShell({ cloudMode: "real" });
    expect(screen.queryByText("app.mock_cloud_header")).not.toBeInTheDocument();
    expect(screen.queryByText("app.localstack_cloud_header")).not.toBeInTheDocument();
  });

  it("should render the mock cloud info alert", () => {
    renderShell({ cloudMode: "mock" });
    expect(screen.getByText("app.mock_cloud_header")).toBeInTheDocument();
  });

  it("should render the localstack warning with the configured endpoint", () => {
    renderShell({ cloudMode: "localstack", localstackEndpoint: "http://localstack:4566" });
    expect(screen.getByText("app.localstack_cloud_header")).toBeInTheDocument();
    expect(screen.getByText(/localstack:4566/)).toBeInTheDocument();
  });

  it("should fall back to the endpoint-missing label when localstack endpoint is unset", () => {
    renderShell({ cloudMode: "localstack" });
    expect(screen.getByText(/app\.localstack_endpoint_missing/)).toBeInTheDocument();
  });

  it("should show the unread notification count badge", () => {
    mockTeamView.mockReturnValue(tv({ view: teamView([10]), unreadNotificationCount: 5 }));
    renderShell();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("should clamp the unread badge to 99+", () => {
    mockTeamView.mockReturnValue(tv({ view: teamView([10]), unreadNotificationCount: 150 }));
    renderShell();
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("should render no unread badge when the count is zero", () => {
    mockTeamView.mockReturnValue(tv({ view: teamView([10]), unreadNotificationCount: 0 }));
    renderShell();
    expect(screen.queryByText("99+")).not.toBeInTheDocument();
  });
});
