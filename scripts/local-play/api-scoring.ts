import { StatusCodes } from "http-status-codes";
import type { AttackProbeFn } from "../lib/scoring-common";
import { revealContainerHint, submitContainerFlag } from "../local-host/container/scoring";
import {
  jobIdOf,
  type LocalPlayRequest,
  type LocalPlayResponse,
  sessionScore,
} from "../local-host/container/state";
import type { LocalPlayState, SimulatedProblemRuntime } from "./api-state";
import type { LocalSimulatorDeployment } from "./simulator-runtime";
import { runSimulatorScoreCycle, simulatorFlagMatches } from "./simulator-scoring";

export async function submitFlag(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
): Promise<LocalPlayResponse> {
  const body = (request.body ?? {}) as { problemId?: unknown; flag?: unknown; flagId?: unknown };
  if (typeof body.problemId !== "string" || typeof body.flag !== "string") {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_flag" } };
  }
  const simulatedRuntime = state.simulatedRuntimes.get(body.problemId);
  if (simulatedRuntime) {
    return submitSimulatorFlag(simulatedRuntime, body.flag, state, iso);
  }
  const runtime = state.runtimes.get(body.problemId);
  if (!runtime) {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_flag" } };
  }
  return submitContainerFlag(runtime, body.flag, body.flagId, state, iso);
}

function submitSimulatorFlag(
  runtime: SimulatedProblemRuntime,
  submitted: string,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const problemId = runtime.problem.problemId;
  if (state.lifecycle.statusOf(problemId) !== "running" || !runtime.deployment) {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  if (runtime.contract.scoring.kind !== "flag") {
    return { status: StatusCodes.NOT_FOUND, body: { kind: "unknown_flag" } };
  }
  state.lifecycle.touch(problemId);
  if (runtime.solved.has(problemId)) {
    return {
      status: StatusCodes.OK,
      body: { kind: "already_scored", totalScore: sessionScore(state) },
    };
  }
  let correct: boolean;
  try {
    correct = simulatorFlagMatches(runtime.problem, runtime.deployment.outputs, submitted);
  } catch {
    return {
      status: StatusCodes.BAD_GATEWAY,
      body: {
        error: "simulator_scoring_unavailable",
        message: "Simulator scoring is unavailable",
      },
    };
  }
  if (correct) {
    runtime.solved.add(problemId);
    runtime.score += runtime.contract.scoring.points;
    state.scoreEvents.unshift({
      jobId: jobIdOf(problemId),
      problemId,
      source: "flag",
      points: runtime.contract.scoring.points,
      result: "ok",
      occurredAt: iso,
    });
    return {
      status: StatusCodes.OK,
      body: {
        kind: "ok",
        scoreDelta: runtime.contract.scoring.points,
        totalScore: sessionScore(state),
      },
    };
  }
  const wrongCount = (runtime.wrongCounts.get(problemId) ?? 0) + 1;
  runtime.wrongCounts.set(problemId, wrongCount);
  const penalty = runtime.contract.scoring.wrongAnswerPenalty ?? 0;
  runtime.score -= penalty;
  state.scoreEvents.unshift({
    jobId: jobIdOf(problemId),
    problemId,
    source: "flag-wrong",
    points: -penalty,
    result: "wrong",
    occurredAt: iso,
  });
  return {
    status: StatusCodes.OK,
    body: {
      kind: "wrong",
      scoreDelta: -penalty,
      totalScore: sessionScore(state),
      wrongCount,
    },
  };
}

function isSimulatorPollingRuntime(runtime: SimulatedProblemRuntime): boolean {
  return runtime.contract.scoring.kind !== "flag";
}

function isCompletedComposite(runtime: SimulatedProblemRuntime, problemId: string): boolean {
  return runtime.contract.scoring.kind === "composite-probe" && runtime.solved.has(problemId);
}

async function advancePhasedSimulatorClock(
  problemId: string,
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  now: number,
): Promise<void> {
  if (runtime.contract.phases.length === 0) return;
  if (!state.simulator) {
    throw new Error("Simulator runtime is required to advance a phased problem clock");
  }
  await state.simulator.advanceClock(problemId, now);
}

function simulatorAttackProbe(
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  now: number,
): AttackProbeFn | undefined {
  const scoring = runtime.contract.scoring;
  if (scoring.kind !== "uptime-multi" || !scoring.attackProbes?.length) return undefined;
  const simulator = state.simulator;
  if (!simulator) {
    throw new Error("Simulator runtime is required to execute attack probes");
  }
  return (request) => simulator.attackProbe(runtime.problem, request, now);
}

function simulatorDeploymentIsCurrent(
  problemId: string,
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  deployment: LocalSimulatorDeployment,
): boolean {
  return state.lifecycle.statusOf(problemId) === "running" && runtime.deployment === deployment;
}

async function authoritativeEndpointPlacements(
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  now: number,
) {
  if (runtime.contract.scoring.kind !== "phased-polling") return undefined;
  const simulator = state.simulator;
  if (!simulator?.endpointPlacements) return undefined;
  return simulator.endpointPlacements(
    runtime.problem,
    runtime.contract.endpoints.map((slot) => slot.slot),
    now,
  );
}

type SimulatorScoreResult = Awaited<ReturnType<typeof runSimulatorScoreCycle>>;

function applySimulatorScoreResult(
  problemId: string,
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  result: SimulatorScoreResult,
): void {
  runtime.score += result.scoreDelta;
  runtime.lastResult = result.lastResult;
  runtime.endpointsHealth = result.endpointsHealthJson;
  runtime.attackProbes = result.attackProbesJson;
  runtime.posture = result.postureJson;
  runtime.platform = result.platform;
  if (result.newState) runtime.scoringState = result.newState;
  if (runtime.contract.scoring.kind === "composite-probe" && result.lastResult === "ok") {
    runtime.solved.add(problemId);
  }
  for (const event of [...result.scoreEvents].reverse()) {
    state.scoreEvents.unshift({
      jobId: jobIdOf(problemId),
      problemId,
      source: event.source,
      points: event.points,
      result: result.lastResult === "fail" ? "wrong" : "ok",
      occurredAt: event.occurredAt,
    });
  }
}

async function runSimulatedProblemScoreCycle(
  problemId: string,
  state: LocalPlayState,
  now = Date.now(),
): Promise<LocalPlayResponse> {
  const runtime = state.simulatedRuntimes.get(problemId);
  if (!runtime?.deployment || state.lifecycle.statusOf(problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  const deployment = runtime.deployment;
  await state.simulator?.refreshAccess(problemId);
  if (!isSimulatorPollingRuntime(runtime)) {
    return {
      status: StatusCodes.OK,
      body: { kind: "not_polling", totalScore: sessionScore(state) },
    };
  }
  if (isCompletedComposite(runtime, problemId)) {
    return {
      status: StatusCodes.OK,
      body: { kind: "already_scored", totalScore: sessionScore(state) },
    };
  }
  await advancePhasedSimulatorClock(problemId, runtime, state, now);
  if (!simulatorDeploymentIsCurrent(problemId, runtime, state, deployment)) {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  const attackProbe = simulatorAttackProbe(runtime, state, now);
  const placements = await authoritativeEndpointPlacements(runtime, state, now);
  const result = await runSimulatorScoreCycle({
    problem: runtime.problem,
    outputs: deployment.outputs,
    overrides: runtime.overrides,
    score: runtime.score,
    createdAt: runtime.createdAt ?? new Date(now).toISOString(),
    ...(runtime.lastResult ? { lastResult: runtime.lastResult } : {}),
    ...(runtime.endpointsHealth ? { endpointsHealth: runtime.endpointsHealth } : {}),
    scoringState: runtime.scoringState,
    nowMs: now,
    ...(attackProbe ? { attackProbe } : {}),
    ...(placements ? { authoritativeEndpointPlacements: placements } : {}),
  });
  if (!simulatorDeploymentIsCurrent(problemId, runtime, state, deployment)) {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  applySimulatorScoreResult(problemId, runtime, state, result);
  return {
    status: StatusCodes.OK,
    body: {
      kind: result.lastResult ?? "no_change",
      scoreDelta: result.scoreDelta,
      totalScore: sessionScore(state),
    },
  };
}

/**
 * Share one in-flight score cycle per problem across every trigger. Besides
 * preventing duplicate awards, this keeps Simulator clock advancement and the
 * corresponding local state commit in the same serialized boundary.
 */
export function scoreSimulatedProblem(
  problemId: string,
  state: LocalPlayState,
  now = Date.now(),
): Promise<LocalPlayResponse> {
  const inFlight = state.simulatorScoringInFlight.get(problemId);
  if (inFlight) return inFlight;
  const cycle = runSimulatedProblemScoreCycle(problemId, state, now);
  const tracked = cycle.then(
    (result) => {
      state.simulatorScoringInFlight.delete(problemId);
      return result;
    },
    (error: unknown) => {
      state.simulatorScoringInFlight.delete(problemId);
      throw error;
    },
  );
  state.simulatorScoringInFlight.set(problemId, tracked);
  return tracked;
}

function revealSimulatorHint(
  runtime: SimulatedProblemRuntime,
  state: LocalPlayState,
  iso: string,
  hintId: string,
): LocalPlayResponse {
  const problemId = runtime.problem.problemId;
  if (state.lifecycle.statusOf(problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  const scoring = runtime.contract.scoring;
  const hints = "hints" in scoring ? (scoring.hints ?? []) : [];
  const hint = hints.find((candidate) => candidate.id === hintId);
  if (!hint) return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  const existing = runtime.revealedHints.get(hint.id);
  if (existing) {
    return {
      status: StatusCodes.OK,
      body: {
        kind: "already_revealed",
        content: state.browserText(hint.content),
        penaltyApplied: 0,
        totalScore: sessionScore(state),
        revealedAt: existing,
      },
    };
  }
  runtime.revealedHints.set(hint.id, iso);
  runtime.score -= hint.penalty;
  if (hint.penalty > 0) {
    state.scoreEvents.unshift({
      jobId: jobIdOf(problemId),
      problemId,
      source: "hint",
      points: -hint.penalty,
      result: "ok",
      occurredAt: iso,
    });
  }
  return {
    status: StatusCodes.OK,
    body: {
      kind: "ok",
      content: state.browserText(hint.content),
      penaltyApplied: hint.penalty,
      totalScore: sessionScore(state),
      revealedAt: iso,
    },
  };
}

export function revealHint(
  problemId: string,
  hintId: string,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const runtime = state.simulatedRuntimes.get(problemId);
  return runtime
    ? revealSimulatorHint(runtime, state, iso, hintId)
    : revealContainerHint(problemId, hintId, state, iso);
}
