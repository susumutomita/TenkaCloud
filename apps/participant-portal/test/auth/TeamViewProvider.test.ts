import { describe, expect, it } from "vitest";
import { type ParticipantTeamView, PortalAuthError } from "../../src/api/portal-client";
import {
  toLeaderboardRefreshDecision,
  toPortalMeRefreshDecision,
} from "../../src/auth/TeamViewProvider";

function teamView(statuses: readonly ParticipantTeamView["problems"][number]["status"][]) {
  return {
    team: {
      teamName: "Blue",
      teamNameSetByCompetitor: true,
    },
    problems: statuses.map((status, index) => ({
      jobId: `job-${index}`,
      problemId: `problem-${index}`,
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      status,
      stackOutputs: {},
      expiresAt: 0,
      score: 0,
      deployLog: { cursor: "0", entries: [] },
    })),
  } satisfies ParticipantTeamView;
}

describe("TeamViewProvider refresh decisions", () => {
  it("portal/me 成功時は view と polling 停止判定を返すべき", () => {
    const active = teamView(["COMPLETE", "FAILED"]);
    expect(toPortalMeRefreshDecision({ status: "fulfilled", value: active })).toEqual({
      kind: "view",
      view: active,
      stopPolling: false,
    });

    const terminal = teamView(["FAILED", "DELETED"]);
    expect(toPortalMeRefreshDecision({ status: "fulfilled", value: terminal })).toEqual({
      kind: "view",
      view: terminal,
      stopPolling: true,
    });
  });

  it("portal/me の認証エラーは logout 判定にすべき", () => {
    expect(
      toPortalMeRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({
      kind: "auth-error",
    });
  });

  it("portal/me の通常エラーは message に変換すべき", () => {
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: new Error("boom") })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: "plain" })).toEqual({
      kind: "error",
      message: "plain",
    });
  });

  it("leaderboard 成功時は no-event と通常更新を区別すべき", () => {
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: undefined })).toEqual({
      kind: "no-event",
    });

    const leaderboard = { eventId: "event-1", entries: [] };
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: leaderboard })).toEqual({
      kind: "leaderboard",
      leaderboard,
    });
  });

  it("leaderboard の認証エラーは無視し通常エラーだけ message に変換すべき", () => {
    expect(
      toLeaderboardRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({
      kind: "auth-error",
    });
    expect(
      toLeaderboardRefreshDecision({ status: "rejected", reason: new Error("leaderboard down") }),
    ).toEqual({
      kind: "error",
      message: "leaderboard down",
    });
  });
});
