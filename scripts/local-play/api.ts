import { StatusCodes } from "http-status-codes";
import { revealHint, submitFlag } from "./api-scoring";
import {
  LOCAL_CONTEXT,
  type LocalPlayRequest,
  type LocalPlayResponse,
  type LocalPlayState,
} from "./api-state";
import { leaderboard, teamView } from "./api-views";

/**
 * [#2527 Slice 6] The local scoring API's HTTP routing + on-demand lifecycle commands.
 * The contract and session state live in `api-state.ts`, the portal views in
 * `api-views.ts`, and the submission/scoring use cases in `api-scoring.ts` — this file
 * only routes requests to them. It owns the participant-facing portal contract but
 * holds NO answer: a flag submission is delegated to the problem container's `/verify`
 * and the verdict is recorded (Issue #2054).
 */

/** [#2392 Phase 2] POST /portal/me/problems/:id/start — on-demand container start. */
async function startProblem(problemId: string, state: LocalPlayState): Promise<LocalPlayResponse> {
  if (!state.runtimes.has(problemId)) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  try {
    await state.lifecycle.ensureRunning(problemId);
  } catch (error) {
    // Fail loudly: a container that would not come up must not look playable.
    return {
      status: StatusCodes.BAD_GATEWAY,
      body: {
        error: "start_failed",
        message: error instanceof Error ? error.message : "problem container failed to start",
      },
    };
  }
  return { status: StatusCodes.OK, body: { status: state.lifecycle.statusOf(problemId) } };
}

/** [#2392 Phase 2] POST /portal/me/problems/:id/stop — release the container + its port slot. */
async function stopProblem(problemId: string, state: LocalPlayState): Promise<LocalPlayResponse> {
  if (!state.runtimes.has(problemId)) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
  }
  await state.lifecycle.stop(problemId);
  return { status: StatusCodes.OK, body: { status: state.lifecycle.statusOf(problemId) } };
}

const START_RE = /^\/portal\/me\/problems\/([^/]+)\/start$/;
const STOP_RE = /^\/portal\/me\/problems\/([^/]+)\/stop$/;
const REVEAL_RE = /^\/portal\/me\/problems\/([^/]+)\/hints\/([^/]+)\/reveal$/;

/** Decode one percent-escaped path segment; undefined when malformed (→ 404, not 500). */
function decodePathSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function handleGet(
  request: LocalPlayRequest,
  state: LocalPlayState,
  now: number,
): LocalPlayResponse | undefined {
  switch (request.path) {
    case "/healthz":
      return {
        status: StatusCodes.OK,
        body: { status: "ok", mode: "local", problemIds: [...state.runtimes.keys()] },
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

function handlePost(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
): Promise<LocalPlayResponse> | LocalPlayResponse | undefined {
  if (request.path === "/portal/me/submit-flag") {
    return submitFlag(request, state, iso);
  }
  const start = START_RE.exec(request.path);
  if (start) {
    const problemId = decodePathSegment(start[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return startProblem(problemId, state);
  }
  const stop = STOP_RE.exec(request.path);
  if (stop) {
    const problemId = decodePathSegment(stop[1]);
    if (problemId === undefined) {
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_problem" } };
    }
    return stopProblem(problemId, state);
  }
  const match = REVEAL_RE.exec(request.path);
  if (match) {
    const problemId = decodePathSegment(match[1]);
    const hintId = decodePathSegment(match[2]);
    if (problemId === undefined || hintId === undefined) {
      // A malformed percent escape is just an unknown hint, not a 500.
      return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
    }
    return revealHint(problemId, hintId, state, iso);
  }
  return undefined;
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
    const response = handlePost(request, state, iso);
    if (response) return response;
  }
  return { status: StatusCodes.NOT_FOUND, body: { error: "not_found" } };
}
