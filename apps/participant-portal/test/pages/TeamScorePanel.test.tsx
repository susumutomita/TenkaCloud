import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  LeaderboardResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../../src/api/portal-client";

/**
 * TeamScorePanel (Home の累計スコア / 順位 / 問題数 / 正解数 サマリ) の集計と rank 表示
 * (自チームが leaderboard にいる / いない・leaderboard 不在) を pin する。 useT は echo mock。
 */
vi.mock("../../src/i18n", () => ({
  useT: () => (key: string) => key,
}));

const { TeamScorePanel } = await import("../../src/pages/TeamScorePanel");

// biome-ignore lint/suspicious/noExplicitAny: テスト fixture を最小形で組む。
const problem = (over: Record<string, any>): ParticipantProblemView =>
  ({
    jobId: "j",
    problemId: "p",
    region: "ap-northeast-1",
    awsAccountId: "1",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...over,
  }) as ParticipantProblemView;

const view = (problems: ParticipantProblemView[]): ParticipantTeamView =>
  ({ problems }) as unknown as ParticipantTeamView;

const problems = [
  problem({ score: 100, scoring: { kind: "flag", flagSubmitted: true } }), // cleared (flag)
  problem({ score: 0, scoring: { kind: "flag", flagSubmitted: false } }), // not cleared
  problem({ score: 60, scoring: { kind: "uptime" } }), // cleared (score>0)
  problem({ score: 0, scoring: { kind: "uptime" } }), // not cleared
];

describe("TeamScorePanel", () => {
  it("should sum the score and count problems and cleared (flag-submitted or score>0)", () => {
    render(<TeamScorePanel view={view(problems)} leaderboard={null} />);
    expect(screen.getByText("160 pt")).toBeInTheDocument(); // total 100+0+60+0
    expect(screen.getByText("4")).toBeInTheDocument(); // problem count
    expect(screen.getByText("2")).toBeInTheDocument(); // cleared: flag-submitted + uptime score>0
  });

  it("should show the rank when the team is on the leaderboard", () => {
    const leaderboard = {
      entries: [
        { rank: 1, isMyTeam: false, teamName: "A", score: 200 },
        { rank: 2, isMyTeam: true, teamName: "Me", score: 160 },
        { rank: 3, isMyTeam: false, teamName: "C", score: 50 },
      ],
    } as unknown as LeaderboardResponse;
    render(<TeamScorePanel view={view(problems)} leaderboard={leaderboard} />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("should fall back to a dash when the team is not on the leaderboard", () => {
    const leaderboard = {
      entries: [{ rank: 1, isMyTeam: false, teamName: "A", score: 200 }],
    } as unknown as LeaderboardResponse;
    render(<TeamScorePanel view={view(problems)} leaderboard={leaderboard} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("should fall back to a dash when there is no leaderboard at all", () => {
    render(<TeamScorePanel view={view([])} leaderboard={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
