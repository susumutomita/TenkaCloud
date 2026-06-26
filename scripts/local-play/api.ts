import { StatusCodes } from "http-status-codes";
import type { LocalPlayDeployment } from "./kumo";

export const LOCAL_CONTEXT = {
  eventId: "local",
  teamId: "local",
} as const;

export interface LocalPlayScoreEvent {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "flag" | "flag-wrong" | "hint";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

export interface LocalPlayState {
  readonly deployment: LocalPlayDeployment;
  readonly solved: Set<string>;
  readonly revealedHints: Map<string, string>;
  readonly wrongCounts: Map<string, number>;
  readonly scoreEvents: LocalPlayScoreEvent[];
  teamName: string;
  score: number;
}

export interface LocalPlayRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface LocalPlayResponse {
  readonly status: number;
  readonly body: unknown;
}

const jobIdOf = (problemId: string) => `local-${problemId}`;

export function createLocalPlayState(
  deployment: LocalPlayDeployment,
  teamName = "Local Player",
): LocalPlayState {
  return {
    deployment,
    solved: new Set(),
    revealedHints: new Map(),
    wrongCounts: new Map(),
    scoreEvents: [],
    teamName,
    score: 0,
  };
}

function hintViews(state: LocalPlayState) {
  return state.deployment.problem.scoring.hints.map((hint) => {
    const revealedAt = state.revealedHints.get(hint.id);
    return {
      id: hint.id,
      penalty: hint.penalty,
      revealed: revealedAt !== undefined,
      ...(revealedAt ? { content: hint.content, revealedAt } : {}),
    };
  });
}

function publicOutputs(state: LocalPlayState): Readonly<Record<string, string>> {
  const outputs = { ...state.deployment.outputs };
  delete outputs[state.deployment.problem.scoring.flagOutputKey];
  return outputs;
}

function problemView(state: LocalPlayState, now: number) {
  const problem = state.deployment.problem;
  const solved = state.solved.has(problem.problemId);
  const discovery = [
    problem.instructions,
    "## Local Kumo",
    "Run this command to inspect the deployed resource:",
    `\`${state.deployment.discoveryCommand}\``,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    description: problem.description,
    instructions: discovery,
    region: "local",
    awsAccountId: "000000000000",
    status: "COMPLETE",
    stackOutputs: publicOutputs(state),
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    score: solved ? problem.scoring.points : 0,
    ...(solved ? { lastResult: "ok" as const } : {}),
    scoring: {
      kind: "flag",
      points: problem.scoring.points,
      flagSubmitted: solved,
      hints: hintViews(state),
    },
    deployLog: { cursor: "", entries: [] },
    createdAt: new Date(now).toISOString(),
  };
}

function teamView(state: LocalPlayState, now: number): LocalPlayResponse {
  return {
    status: StatusCodes.OK,
    body: {
      team: {
        teamName: state.teamName,
        teamNameSetByCompetitor: true,
        eventId: LOCAL_CONTEXT.eventId,
        teamId: LOCAL_CONTEXT.teamId,
      },
      problems: [problemView(state, now)],
      eventGate: { kind: "ok" },
    },
  };
}

function applyPenalty(state: LocalPlayState, requestedPenalty: number): number {
  const applied = Math.min(state.score, requestedPenalty);
  state.score -= applied;
  return applied;
}

function submitFlag(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const body = (request.body ?? {}) as { problemId?: unknown; flag?: unknown };
  const problem = state.deployment.problem;
  if (body.problemId !== problem.problemId || typeof body.flag !== "string") {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_flag" } };
  }
  if (state.solved.has(problem.problemId)) {
    return {
      status: StatusCodes.OK,
      body: { kind: "already_scored", totalScore: state.score },
    };
  }

  if (body.flag.trim() === state.deployment.expectedFlag) {
    state.solved.add(problem.problemId);
    state.score += problem.scoring.points;
    state.scoreEvents.unshift({
      jobId: jobIdOf(problem.problemId),
      problemId: problem.problemId,
      source: "flag",
      points: problem.scoring.points,
      result: "ok",
      occurredAt: iso,
    });
    return {
      status: StatusCodes.OK,
      body: {
        kind: "ok",
        scoreDelta: problem.scoring.points,
        totalScore: state.score,
      },
    };
  }

  const wrongCount = (state.wrongCounts.get(problem.problemId) ?? 0) + 1;
  state.wrongCounts.set(problem.problemId, wrongCount);
  const penalty = applyPenalty(state, problem.scoring.wrongAnswerPenalty);
  const scoreDelta = penalty === 0 ? 0 : -penalty;
  state.scoreEvents.unshift({
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    source: "flag-wrong",
    points: scoreDelta,
    result: "wrong",
    occurredAt: iso,
  });
  return {
    status: StatusCodes.OK,
    body: {
      kind: "wrong",
      scoreDelta,
      totalScore: state.score,
      wrongCount,
    },
  };
}

function revealHint(
  problemId: string,
  hintId: string,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const problem = state.deployment.problem;
  const hint = problem.scoring.hints.find((candidate) => candidate.id === hintId);
  if (problemId !== problem.problemId || !hint) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }
  const existing = state.revealedHints.get(hint.id);
  if (existing) {
    return {
      status: StatusCodes.OK,
      body: {
        kind: "already_revealed",
        content: hint.content,
        penaltyApplied: 0,
        totalScore: state.score,
        revealedAt: existing,
      },
    };
  }
  const penalty = applyPenalty(state, hint.penalty);
  state.revealedHints.set(hint.id, iso);
  if (penalty > 0) {
    state.scoreEvents.unshift({
      jobId: jobIdOf(problem.problemId),
      problemId: problem.problemId,
      source: "hint",
      points: -penalty,
      result: "ok",
      occurredAt: iso,
    });
  }
  return {
    status: StatusCodes.OK,
    body: {
      kind: "ok",
      content: hint.content,
      penaltyApplied: penalty,
      totalScore: state.score,
      revealedAt: iso,
    },
  };
}

function leaderboard(state: LocalPlayState): LocalPlayResponse {
  return {
    status: StatusCodes.OK,
    body: {
      eventId: LOCAL_CONTEXT.eventId,
      entries: [
        {
          rank: 1,
          teamId: LOCAL_CONTEXT.teamId,
          teamName: state.teamName,
          score: state.score,
          completedProblems: state.solved.size,
          totalProblems: 1,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    },
  };
}

const REVEAL_RE = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/;

function handleGet(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  switch (request.path) {
    case "/healthz":
      return {
        status: StatusCodes.OK,
        body: {
          status: "ok",
          mode: "localstack",
          problemId: state.deployment.problem.problemId,
        },
      };
    case "/portal/me":
      return teamView(state, now);
    case "/portal/me/score-events":
      return { status: StatusCodes.OK, body: { entries: state.scoreEvents } };
    case "/portal/leaderboard":
      return leaderboard(state);
    case "/portal/leaderboard/score-events":
      return {
        status: StatusCodes.OK,
        body: {
          eventId: LOCAL_CONTEXT.eventId,
          teams: [
            {
              teamId: LOCAL_CONTEXT.teamId,
              teamName: state.teamName,
              isMyTeam: true,
              events: state.scoreEvents,
            },
          ],
        },
      };
    case "/portal/me/notifications":
      return {
        status: StatusCodes.OK,
        body: { eventId: LOCAL_CONTEXT.eventId, items: [] },
      };
    case "/portal/me/deploy-logs":
      return {
        status: StatusCodes.OK,
        body: { jobId: request.query.jobId ?? "", complete: true, entries: [] },
      };
  }
  return undefined;
}

function handlePatch(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  if (request.path !== "/portal/me") return undefined;
  const body = (request.body ?? {}) as { teamName?: unknown };
  if (typeof body.teamName !== "string" || body.teamName.trim().length === 0) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_team_name" } };
  }
  state.teamName = body.teamName.trim();
  return teamView(state, now);
}

export function handleLocalPlayRequest(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now = Date.now(),
): LocalPlayResponse {
  const iso = new Date(now).toISOString();
  let response: LocalPlayResponse | undefined;
  if (request.method === "GET") response = handleGet(request, state, now);
  if (request.method === "PATCH") response = handlePatch(request, state, now);
  if (request.method === "POST" && request.path === "/portal/me/submit-flag") {
    response = submitFlag(request, state, iso);
  }
  if (request.method === "POST") {
    const match = REVEAL_RE.exec(request.path);
    if (match) {
      response = revealHint(decodeURIComponent(match[1]), decodeURIComponent(match[2]), state, iso);
    }
  }
  return (
    response ?? {
      status: StatusCodes.NOT_FOUND,
      body: { error: "not_found" },
    }
  );
}
