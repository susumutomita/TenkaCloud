import { describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse, ParticipantTeamView } from "../../src/api/portal-client";
import {
  buildProfileMenuItems,
  formatTopNavRank,
  formatTopNavScore,
  handleProfileMenuClick,
  isSupportedLocaleId,
} from "../../src/components/AppLayout";

function teamView(scores: readonly number[]) {
  return {
    team: {
      teamName: "Blue",
      teamNameSetByCompetitor: true,
    },
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

function leaderboard(entries: LeaderboardResponse["entries"]) {
  return {
    eventId: "event-1",
    entries,
  } satisfies LeaderboardResponse;
}

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

  it("should accept only supported locale ids", () => {
    expect(isSupportedLocaleId("ja")).toBe(true);
    expect(isSupportedLocaleId("en")).toBe(true);
    expect(isSupportedLocaleId("fr")).toBe(false);
  });
});

describe("profile dropdown menu (Issue #1191)", () => {
  it("should list change_team_name before logout so the destructive action is visually last", () => {
    const items = buildProfileMenuItems((key) => `<${key}>`);
    expect(items).toEqual([
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
