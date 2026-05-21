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
  it("should return view and polling stop decision on portal/me success", () => {
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

  it("should treat portal/me auth error as a logout decision", () => {
    expect(
      toPortalMeRefreshDecision({ status: "rejected", reason: new PortalAuthError() }),
    ).toEqual({
      kind: "auth-error",
    });
  });

  it("should convert generic portal/me errors to a message", () => {
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: new Error("boom") })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(toPortalMeRefreshDecision({ status: "rejected", reason: "plain" })).toEqual({
      kind: "error",
      message: "plain",
    });
  });

  it("should distinguish no-event from regular updates on leaderboard success", () => {
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: undefined })).toEqual({
      kind: "no-event",
    });

    const leaderboard = { eventId: "event-1", entries: [] };
    expect(toLeaderboardRefreshDecision({ status: "fulfilled", value: leaderboard })).toEqual({
      kind: "leaderboard",
      leaderboard,
    });
  });

  it("should ignore leaderboard auth errors and convert only generic errors to a message", () => {
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
