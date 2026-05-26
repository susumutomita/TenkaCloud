import { describe, expect, it } from "vitest";
import type {
  LeaderboardResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../../src/api/portal-client";
import { computeNextActionState } from "../../src/components/NextActionHero";

/**
 * Issue #1349 — Home tab の 「次にやること」 hero の 3 状態 (not_started / running /
 * ended) を pin する。 React render を mount せず、 hero が依存する純粋判定 helper を
 * Home の representative scenario で回す (= 利用者視点の input → 状態 mapping)。
 */

function problem(
  partial: Partial<ParticipantProblemView> & Pick<ParticipantProblemView, "problemId" | "jobId">,
): ParticipantProblemView {
  return {
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    ...partial,
  };
}

const NOW = Date.parse("2026-05-22T13:00:00Z");

describe("Home next-action hero (Issue #1349)", () => {
  it("should pick scoring_not_started state when the event has not started yet", () => {
    const view: ParticipantTeamView = {
      team: { teamName: "Blue", teamNameSetByCompetitor: true },
      problems: [problem({ jobId: "j1", problemId: "hello-world", scoring: { kind: "flag" } })],
      eventGate: { kind: "scoring_not_started", startsAt: "2026-05-22T14:00:00Z" },
    };
    const state = computeNextActionState({ view, leaderboard: null, nowMs: NOW });
    expect(state).toEqual({ kind: "not_started", startsAt: "2026-05-22T14:00:00Z" });
  });

  it("should pick running state with the first unsolved problemId during the competition", () => {
    const view: ParticipantTeamView = {
      team: { teamName: "Blue", teamNameSetByCompetitor: true },
      problems: [
        problem({
          jobId: "j1",
          problemId: "hello-world",
          scoring: { kind: "flag", flagSubmitted: false },
        }),
        problem({
          jobId: "j2",
          problemId: "lambda-uptime",
          scoring: { kind: "uptime" },
          score: 60,
        }),
      ],
      eventGate: { kind: "ok" },
    };
    const state = computeNextActionState({ view, leaderboard: null, nowMs: NOW });
    expect(state?.kind).toBe("running");
    if (state?.kind === "running") {
      // flag 1 件のみ unsolved (uptime は score>0 で in-progress として扱う)。
      expect(state.unsolvedCount).toBe(1);
      expect(state.nextProblem?.problemId).toBe("hello-world");
    }
  });

  it("should pick ended state with finalRank when the competition is over", () => {
    const view: ParticipantTeamView = {
      team: { teamName: "Blue", teamNameSetByCompetitor: true },
      problems: [],
      eventGate: { kind: "scoring_ended", endsAt: "2026-05-22T12:30:00Z" },
    };
    const leaderboard: LeaderboardResponse = {
      eventId: "evt-1",
      entries: [
        {
          rank: 3,
          teamId: "t-me",
          teamName: "Blue",
          score: 120,
          completedProblems: 1,
          totalProblems: 2,
          isMyTeam: true,
        },
      ],
      endsAt: "2026-05-22T12:30:00Z",
    };
    const state = computeNextActionState({ view, leaderboard, nowMs: NOW });
    expect(state).toEqual({ kind: "ended", finalRank: 3, totalEntries: 1 });
  });
});
