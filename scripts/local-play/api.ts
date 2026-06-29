import { StatusCodes } from "http-status-codes";
import type { ContainerProblem } from "./manifest";
import { type VerifyContext, type VerifyResult, verifySubmission } from "./verify-client";

/**
 * The local scoring API. It owns the participant-facing portal contract (team
 * view, leaderboard, hints, score events) but holds NO answer: a flag
 * submission is delegated to the problem container's `/verify` and the verdict
 * is recorded. The participant sees a single-submission ("flag") problem; the
 * platform never evaluates correctness itself (Issue #2054).
 */

export const LOCAL_CONTEXT = {
  eventId: "local",
  teamId: "local",
} as const;

export interface LocalPlayDeployment {
  readonly problem: ContainerProblem;
}

export type VerifyFn = (
  verifyUrl: string,
  submission: string,
  context: VerifyContext,
) => Promise<VerifyResult>;

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
  readonly verify: VerifyFn;
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

export interface CreateStateOptions {
  readonly teamName?: string;
  readonly verify?: VerifyFn;
}

export function createLocalPlayState(
  deployment: LocalPlayDeployment,
  options: CreateStateOptions = {},
): LocalPlayState {
  return {
    deployment,
    solved: new Set(),
    revealedHints: new Map(),
    wrongCounts: new Map(),
    scoreEvents: [],
    verify: options.verify ?? verifySubmission,
    teamName: options.teamName ?? "Local Player",
    score: 0,
  };
}

/**
 * Identity check for the readiness probe: is the server answering `/healthz`
 * *our* local-play instance for `problemId`? Guards against silently adopting a
 * foreign server squatting on the API port.
 */
export function isLocalApiHealthy(body: unknown, problemId: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const payload = body as { status?: unknown; mode?: unknown; problemId?: unknown };
  return payload.status === "ok" && payload.mode === "local" && payload.problemId === problemId;
}

function hintViews(state: LocalPlayState) {
  return state.deployment.problem.scoring.hints.map((hint) => {
    const revealedAt = state.revealedHints.get(hint.id);
    return {
      id: hint.id,
      penalty: hint.penalty,
      revealed: revealedAt !== undefined,
      // Keep the translated content gated behind reveal too — never leak the
      // hint in any language before it is unlocked.
      ...(revealedAt
        ? { content: hint.content, revealedAt, ...(hint.i18n ? { i18n: hint.i18n } : {}) }
        : {}),
    };
  });
}

function problemView(state: LocalPlayState, now: number) {
  const problem = state.deployment.problem;
  const solved = state.solved.has(problem.problemId);
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    description: problem.description,
    instructions: problem.instructions,
    // #2054 i18n: ship the en overlay so the portal locale switcher can render
    // the problem in English (ja stays the top-level canonical).
    ...(problem.i18n ? { i18n: problem.i18n } : {}),
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    // The challenge surface URLs the participant attacks (loopback only).
    stackOutputs: problem.challengeEndpoints,
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    score: solved ? problem.scoring.points : 0,
    ...(solved ? { lastResult: "ok" as const } : {}),
    // Participant-facing kind is a single submission box; scoring is delegated.
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

/**
 * Deduct a hint/wrong-answer penalty in full. The score is allowed to go
 * negative so a penalty always costs what it says — clamping the deduction to
 * the current score would make hints free at the start of play (when score is
 * 0), letting a player reveal the answer-bearing hint for nothing.
 */
function applyPenalty(state: LocalPlayState, penalty: number): number {
  state.score -= penalty;
  return penalty;
}

async function submitFlag(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
): Promise<LocalPlayResponse> {
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

  let verdict: VerifyResult;
  try {
    verdict = await state.verify(problem.verifyUrl, body.flag, {
      teamId: LOCAL_CONTEXT.teamId,
      problemId: problem.problemId,
    });
  } catch (error) {
    // Fail loudly — never silently mark wrong/right when the container's /verify
    // is unreachable or misbehaving. The portal surfaces this as an error.
    return {
      status: StatusCodes.BAD_GATEWAY,
      body: {
        error: "verify_unavailable",
        message: error instanceof Error ? error.message : "problem container /verify failed",
      },
    };
  }

  if (verdict.correct) {
    state.solved.add(problem.problemId);
    const award = verdict.points ?? problem.scoring.points;
    state.score += award;
    state.scoreEvents.unshift({
      jobId: jobIdOf(problem.problemId),
      problemId: problem.problemId,
      source: "flag",
      points: award,
      result: "ok",
      occurredAt: iso,
    });
    return {
      status: StatusCodes.OK,
      body: { kind: "ok", scoreDelta: award, totalScore: state.score },
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
    body: { kind: "wrong", scoreDelta, totalScore: state.score, wrongCount },
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
  const i18n = hint.i18n ? { i18n: hint.i18n } : {};
  const existing = state.revealedHints.get(hint.id);
  if (existing) {
    return {
      status: StatusCodes.OK,
      body: {
        kind: "already_revealed",
        content: hint.content,
        ...i18n,
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
      ...i18n,
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
        body: { status: "ok", mode: "local", problemId: state.deployment.problem.problemId },
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
      return { status: StatusCodes.OK, body: { eventId: LOCAL_CONTEXT.eventId, items: [] } };
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

export async function handleLocalPlayRequest(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now = Date.now(),
): Promise<LocalPlayResponse> {
  const iso = new Date(now).toISOString();
  if (request.method === "GET") {
    const response = handleGet(request, state, now);
    if (response) return response;
  }
  if (request.method === "PATCH") {
    const response = handlePatch(request, state, now);
    if (response) return response;
  }
  if (request.method === "POST") {
    if (request.path === "/portal/me/submit-flag") {
      return submitFlag(request, state, iso);
    }
    const match = REVEAL_RE.exec(request.path);
    if (match) {
      let problemId: string;
      let hintId: string;
      try {
        problemId = decodeURIComponent(match[1]);
        hintId = decodeURIComponent(match[2]);
      } catch {
        // A malformed percent escape is just an unknown hint, not a 500.
        return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
      }
      return revealHint(problemId, hintId, state, iso);
    }
  }
  return { status: StatusCodes.NOT_FOUND, body: { error: "not_found" } };
}
