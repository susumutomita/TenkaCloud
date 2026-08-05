import { describe, expect, it } from "vitest";
import type {
  LeaderboardResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "../../src/api/portal-client";
import {
  computeNextActionState,
  isProblemUnsolved,
  pickNextProblem,
} from "../../src/components/NextActionHero";

/**
 * Issue #1349: Home tab の Next action hero の 3 状態判定を pin する。
 * UI render は SpaceBetween / Header の Cloudscape mount が jsdom で重いため、
 * pure helper 単体で 3 状態 (not_started / running / ended / all_cleared) を回す。
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

function view(args: {
  readonly problems: readonly ParticipantProblemView[];
  readonly eventGate?: ParticipantTeamView["eventGate"];
}): ParticipantTeamView {
  return {
    team: { teamName: "Blue", teamNameSetByCompetitor: true },
    problems: args.problems,
    eventGate: args.eventGate,
  };
}

function leaderboard(args: {
  readonly endsAt?: string;
  readonly entries?: LeaderboardResponse["entries"];
}): LeaderboardResponse {
  return {
    eventId: "evt-1",
    endsAt: args.endsAt,
    entries: args.entries ?? [],
  };
}

const now = Date.parse("2026-05-22T13:00:00Z");

describe("isProblemUnsolved", () => {
  it("should treat flag problem with flagSubmitted=true as solved", () => {
    expect(
      isProblemUnsolved(
        problem({
          jobId: "j1",
          problemId: "p1",
          scoring: { kind: "flag", flagSubmitted: true },
        }),
      ),
    ).toBe(false);
  });

  it("should treat flag problem with flagSubmitted=false as unsolved", () => {
    expect(
      isProblemUnsolved(
        problem({
          jobId: "j1",
          problemId: "p1",
          scoring: { kind: "flag", flagSubmitted: false },
        }),
      ),
    ).toBe(true);
  });

  it("should treat uptime problem with score>0 as not unsolved (= scoring underway)", () => {
    expect(
      isProblemUnsolved(
        problem({ jobId: "j1", problemId: "p1", scoring: { kind: "uptime" }, score: 100 }),
      ),
    ).toBe(false);
  });

  it("should treat FAILED / DELETED problems as not actionable", () => {
    expect(isProblemUnsolved(problem({ jobId: "j1", problemId: "p1", status: "FAILED" }))).toBe(
      false,
    );
    expect(isProblemUnsolved(problem({ jobId: "j1", problemId: "p1", status: "DELETED" }))).toBe(
      false,
    );
  });
});

describe("pickNextProblem", () => {
  it("should prefer COMPLETE-status unsolved over IN_PROGRESS deploys", () => {
    const inProgress = problem({
      jobId: "j-a",
      problemId: "a-problem",
      status: "IN_PROGRESS",
      scoring: { kind: "flag" },
    });
    const ready = problem({
      jobId: "j-b",
      problemId: "b-problem",
      status: "COMPLETE",
      scoring: { kind: "flag" },
    });
    expect(pickNextProblem([inProgress, ready])?.problemId).toBe("b-problem");
  });

  it("should pick the first ready problem in view order, not lexical order (#2711)", () => {
    const a = problem({
      jobId: "j-a",
      problemId: "alpha",
      status: "COMPLETE",
      scoring: { kind: "flag" },
    });
    const b = problem({
      jobId: "j-b",
      problemId: "bravo",
      status: "COMPLETE",
      scoring: { kind: "flag" },
    });
    // 表示順 (= 引数順) が journey order の正。 辞書順なら alpha になってしまう。
    expect(pickNextProblem([b, a])?.problemId).toBe("bravo");
  });

  it("should return undefined when nothing is unsolved", () => {
    const cleared = problem({
      jobId: "j-a",
      problemId: "p",
      scoring: { kind: "flag", flagSubmitted: true },
    });
    expect(pickNextProblem([cleared])).toBeUndefined();
  });
});

describe("computeNextActionState", () => {
  it("should return null when no view is loaded", () => {
    expect(computeNextActionState({ view: null, leaderboard: null, nowMs: now })).toBeNull();
  });

  it("should return not_started when eventGate is scoring_not_started", () => {
    const v = view({
      problems: [],
      eventGate: { kind: "scoring_not_started", startsAt: "2026-05-22T14:00:00Z" },
    });
    const state = computeNextActionState({ view: v, leaderboard: null, nowMs: now });
    expect(state).toEqual({ kind: "not_started", startsAt: "2026-05-22T14:00:00Z" });
  });

  it("should return ended when backend gate is scoring_ended", () => {
    const v = view({
      problems: [],
      eventGate: { kind: "scoring_ended", endsAt: "2026-05-22T12:00:00Z" },
    });
    const lb = leaderboard({
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
        {
          rank: 1,
          teamId: "t-other",
          teamName: "Red",
          score: 999,
          completedProblems: 2,
          totalProblems: 2,
          isMyTeam: false,
        },
      ],
    });
    const state = computeNextActionState({ view: v, leaderboard: lb, nowMs: now });
    expect(state).toEqual({ kind: "ended", finalRank: 3, totalEntries: 2 });
  });

  it("should return ended when leaderboard.endsAt has passed even if backend gate is ok", () => {
    const v = view({ problems: [], eventGate: { kind: "ok" } });
    const lb = leaderboard({ endsAt: "2026-05-22T12:00:00Z", entries: [] });
    const state = computeNextActionState({ view: v, leaderboard: lb, nowMs: now });
    expect(state?.kind).toBe("ended");
  });

  it("should return running with unsolved count and next problem during the competition", () => {
    const a = problem({
      jobId: "j-a",
      problemId: "hello-world",
      status: "COMPLETE",
      scoring: { kind: "flag" },
    });
    const b = problem({
      jobId: "j-b",
      problemId: "zeta",
      status: "COMPLETE",
      scoring: { kind: "flag" },
    });
    const v = view({ problems: [a, b], eventGate: { kind: "ok" } });
    const state = computeNextActionState({ view: v, leaderboard: null, nowMs: now });
    expect(state?.kind).toBe("running");
    if (state?.kind === "running") {
      expect(state.unsolvedCount).toBe(2);
      expect(state.nextProblem?.problemId).toBe("hello-world");
    }
  });

  it("should return all_cleared only when every problem is a submitted flag", () => {
    const cleared = problem({
      jobId: "j-a",
      problemId: "p",
      scoring: { kind: "flag", flagSubmitted: true },
    });
    const v = view({ problems: [cleared], eventGate: { kind: "ok" } });
    const state = computeNextActionState({ view: v, leaderboard: null, nowMs: now });
    expect(state).toEqual({ kind: "all_cleared" });
  });

  it("should return defending (not all_cleared) for a scoring uptime Battle problem", () => {
    // uptime は score>0 でも「解き終わり」が無い。 競技中に all_cleared を出すのは誤り (#this)。
    const upAndScoring = problem({
      jobId: "j-a",
      problemId: "hello-world-battle",
      status: "COMPLETE",
      scoring: { kind: "uptime" },
      score: 100,
    });
    const v = view({ problems: [upAndScoring], eventGate: { kind: "ok" } });
    const state = computeNextActionState({ view: v, leaderboard: null, nowMs: now });
    expect(state).toEqual({ kind: "defending" });
  });

  it("should return defending for a mixed event once all flags are submitted but uptime is up", () => {
    const flagDone = problem({
      jobId: "j-a",
      problemId: "a-flag",
      scoring: { kind: "flag", flagSubmitted: true },
    });
    const uptimeUp = problem({
      jobId: "j-b",
      problemId: "b-uptime",
      status: "COMPLETE",
      scoring: { kind: "uptime" },
      score: 100,
    });
    const v = view({ problems: [flagDone, uptimeUp], eventGate: { kind: "ok" } });
    const state = computeNextActionState({ view: v, leaderboard: null, nowMs: now });
    expect(state).toEqual({ kind: "defending" });
  });
});

describe("next action follows the course track", () => {
  const checkpoint = (id: string, solved: boolean) => ({ id, label: id, points: 10, solved });

  it("keeps a partly solved checkpoint problem in the unsolved set", () => {
    const partly = problem({
      problemId: "p",
      jobId: "j",
      score: 10,
      scoring: { kind: "multi-flag", flags: [checkpoint("a", true), checkpoint("b", false)] },
    });
    expect(isProblemUnsolved(partly)).toBe(true);
  });

  it("treats a checkpoint problem as solved only once every checkpoint is in", () => {
    const done = problem({
      problemId: "p",
      jobId: "j",
      score: 20,
      scoring: { kind: "multi-flag", flags: [checkpoint("a", true), checkpoint("b", true)] },
    });
    expect(isProblemUnsolved(done)).toBe(false);
  });

  it("recommends the track's next problem instead of the first one listed", () => {
    const problems = [
      problem({ problemId: "ac26-bridge-properties", jobId: "j1" }),
      problem({ problemId: "stackstack-onboarding", jobId: "j2" }),
    ];
    expect(pickNextProblem(problems)?.problemId).toBe("ac26-bridge-properties");
    expect(pickNextProblem(problems, "stackstack-onboarding")?.problemId).toBe(
      "stackstack-onboarding",
    );
  });

  it("ignores a recommendation the participant has already solved", () => {
    const problems = [
      problem({ problemId: "a", jobId: "j1" }),
      problem({
        problemId: "b",
        jobId: "j2",
        scoring: { kind: "flag", flagSubmitted: true },
      }),
    ];
    expect(pickNextProblem(problems, "b")?.problemId).toBe("a");
  });
});
