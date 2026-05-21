import { describe, expect, it } from "vitest";
import type { LeaderboardResponse, ParticipantTeamView } from "../../src/api/portal-client";
import {
  formatTopNavRank,
  formatTopNavScore,
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
  it("backend mode では取得済み score を合算表示すべき", () => {
    expect(formatTopNavScore("backend", teamView([10, 15, -3]))).toBe("22 pt");
  });

  it("backend 未取得または mock mode では score fallback を表示すべき", () => {
    expect(formatTopNavScore("backend", null)).toBe("…");
    expect(formatTopNavScore("dev-mock", teamView([10]))).toBe("—");
  });

  it("backend mode では自チーム rank と総チーム数を表示すべき", () => {
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

  it("rank が取得不能な場合は状態に応じた fallback を表示すべき", () => {
    expect(formatTopNavRank("dev-mock", null, false)).toBe("—");
    expect(formatTopNavRank("backend", null, true)).toBe("—");
    expect(formatTopNavRank("backend", null, false)).toBe("…");
    expect(formatTopNavRank("backend", leaderboard([]), false)).toBe("…");
  });

  it("対応 locale id だけを受け入れるべき", () => {
    expect(isSupportedLocaleId("ja")).toBe(true);
    expect(isSupportedLocaleId("en")).toBe(true);
    expect(isSupportedLocaleId("fr")).toBe(false);
  });
});
