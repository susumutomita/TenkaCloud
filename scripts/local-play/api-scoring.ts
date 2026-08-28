import { StatusCodes } from "http-status-codes";
import type { AttackProbeFn } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/shared";
import {
  jobIdOf,
  LOCAL_CONTEXT,
  type LocalPlayRequest,
  type LocalPlayResponse,
  type LocalPlayState,
  type ProblemRuntime,
  type SimulatedProblemRuntime,
  sessionScore,
} from "./api-state";
import { mapStrings } from "./port-remap";
import type { LocalSimulatorDeployment } from "./simulator-runtime";
import { runSimulatorScoreCycle, simulatorFlagMatches } from "./simulator-scoring";
import type { VerifyResult } from "./verify-client";

/**
 * [#2527 Slice 6] Submission + scoring use cases for the local scoring API, extracted
 * verbatim from `api.ts`: flag submission (delegated to the container's `/verify` —
 * the platform never evaluates correctness itself, #2054), idempotent award / penalty
 * recording, and paid hint reveals. Mutates {@link LocalPlayState}; no routing.
 */

/**
 * Deduct a hint/wrong-answer penalty in full. The score is allowed to go
 * negative so a penalty always costs what it says — clamping the deduction to
 * the current score would make hints free at the start of play (when score is
 * 0), letting a player reveal the answer-bearing hint for nothing.
 */
function applyPenalty(runtime: ProblemRuntime, penalty: number): number {
  runtime.score -= penalty;
  return penalty;
}

/**
 * [#2252] One submission target: the whole problem (verify) or one checkpoint
 * (multi-verify). Normalizing here keeps a single scoring path below — the
 * idempotency key, the award, the penalty and the wrong-count are all owned by
 * the target, and the container verdict can never override the award
 * (metadata is the single source of points for multi-verify).
 */
interface SubmissionTarget {
  /** solved / wrongCounts key: problemId (verify) or check id (multi-verify). */
  readonly key: string;
  readonly points: number;
  readonly wrongAnswerPenalty: number;
  readonly checkpointId?: string;
  /** verify kind may honor the container's points override; multi-verify must not. */
  readonly allowPointsOverride: boolean;
}

function resolveSubmissionTarget(
  runtime: ProblemRuntime,
  flagId: unknown,
): SubmissionTarget | undefined {
  const problem = runtime.problem;
  if (problem.scoring.kind === "verify") {
    // Single-submission problems ignore flagId (mirrors the AWS single-flag path).
    return {
      key: problem.problemId,
      points: problem.scoring.points,
      wrongAnswerPenalty: problem.scoring.wrongAnswerPenalty,
      allowPointsOverride: true,
    };
  }
  // multi-verify: flagId is required and must name a metadata check (fail-closed;
  // an unknown checkpoint is never forwarded to the container).
  if (typeof flagId !== "string") return undefined;
  const check = problem.scoring.checks.find((candidate) => candidate.id === flagId);
  if (!check) return undefined;
  return {
    key: check.id,
    points: check.points,
    wrongAnswerPenalty: check.wrongAnswerPenalty,
    checkpointId: check.id,
    allowPointsOverride: false,
  };
}

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

async function submitContainerFlag(
  runtime: ProblemRuntime,
  flag: string,
  flagId: unknown,
  state: LocalPlayState,
  iso: string,
): Promise<LocalPlayResponse> {
  const problem = runtime.problem;
  // [#2392 Phase 2] A stopped container cannot judge — refuse loudly instead of
  // timing out against a down /verify. Playing bumps LRU recency (touch) so an
  // actively played problem is the last pick for cap eviction.
  if (state.lifecycle.statusOf(problem.problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  state.lifecycle.touch(problem.problemId);
  const target = resolveSubmissionTarget(runtime, flagId);
  if (!target) {
    // Mirrors the AWS multi-flag contract: unknown / missing flagId → 404
    // { kind: "unknown_flag" } (route-helpers ERROR_STATUS).
    return { status: StatusCodes.NOT_FOUND, body: { kind: "unknown_flag" } };
  }
  const flagIdEcho = target.checkpointId !== undefined ? { flagId: target.checkpointId } : {};
  if (runtime.solved.has(target.key)) {
    // Idempotent per (problemId, checkpointId): a re-submission — right or
    // wrong — never re-calls the container, never re-awards, never re-penalizes.
    return {
      status: StatusCodes.OK,
      body: { kind: "already_scored", totalScore: sessionScore(state), ...flagIdEcho },
    };
  }

  const context = { teamId: LOCAL_CONTEXT.teamId, problemId: problem.problemId };
  let verdict: VerifyResult;
  try {
    // Keep the legacy 3-arg call for verify problems (call-shape compat);
    // multi-verify adds the checkpoint the container must judge and echo.
    verdict =
      target.checkpointId !== undefined
        ? await state.verify(problem.verifyUrl, flag, context, {
            checkpointId: target.checkpointId,
          })
        : await state.verify(problem.verifyUrl, flag, context);
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

  return verdict.correct
    ? recordCorrect(state, runtime, target, verdict, iso, flagIdEcho)
    : recordWrong(state, runtime, target, verdict, iso, flagIdEcho);
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

/** Award a correct submission's points (metadata is authoritative for multi-verify). */
function recordCorrect(
  state: LocalPlayState,
  runtime: ProblemRuntime,
  target: SubmissionTarget,
  verdict: VerifyResult,
  iso: string,
  flagIdField: { flagId?: string },
): LocalPlayResponse {
  runtime.solved.add(target.key);
  const award = target.allowPointsOverride ? (verdict.points ?? target.points) : target.points;
  runtime.score += award;
  state.scoreEvents.unshift({
    jobId: jobIdOf(runtime.problem.problemId),
    problemId: runtime.problem.problemId,
    source: "flag",
    points: award,
    result: "ok",
    occurredAt: iso,
  });
  return {
    status: StatusCodes.OK,
    body: { kind: "ok", scoreDelta: award, totalScore: sessionScore(state), ...flagIdField },
  };
}

/** Record a wrong submission and its (possibly zero) penalty. */
function recordWrong(
  state: LocalPlayState,
  runtime: ProblemRuntime,
  target: SubmissionTarget,
  verdict: VerifyResult,
  iso: string,
  flagIdField: { flagId?: string },
): LocalPlayResponse {
  const wrongCount = (runtime.wrongCounts.get(target.key) ?? 0) + 1;
  runtime.wrongCounts.set(target.key, wrongCount);
  const penalty = applyPenalty(runtime, target.wrongAnswerPenalty);
  const scoreDelta = penalty === 0 ? 0 : -penalty;
  state.scoreEvents.unshift({
    jobId: jobIdOf(runtime.problem.problemId),
    problemId: runtime.problem.problemId,
    source: "flag-wrong",
    points: scoreDelta,
    result: "wrong",
    occurredAt: iso,
  });
  // The container's leak-free failure reason (VerifyResponseSchema caps it at
  // 2000 chars); absent for containers that judge silently.
  const messageField =
    verdict.message !== undefined && verdict.message !== "" ? { message: verdict.message } : {};
  return {
    status: StatusCodes.OK,
    body: {
      kind: "wrong",
      scoreDelta,
      totalScore: sessionScore(state),
      wrongCount,
      ...messageField,
      ...flagIdField,
    },
  };
}

export function revealHint(
  problemId: string,
  hintId: string,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const runtime = state.runtimes.get(problemId);
  const simulatedRuntime = state.simulatedRuntimes.get(problemId);
  if (!runtime && !simulatedRuntime) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }
  if (simulatedRuntime) return revealSimulatorHint(simulatedRuntime, state, iso, hintId);
  // [#2392 Phase 2] Hints are part of playing the problem — gate on a running
  // container and bump its LRU recency, matching submit.
  if (state.lifecycle.statusOf(problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  state.lifecycle.touch(problemId);
  const problem = runtime.problem;
  // [#2252] multi-verify hints live per check; ids are unique across the problem
  // (enforced by the manifest) so the flat reveal route stays unambiguous.
  const allHints =
    problem.scoring.kind === "verify"
      ? problem.scoring.hints
      : problem.scoring.checks.flatMap((check) => check.hints);
  const hint = allHints.find((candidate) => candidate.id === hintId);
  if (!hint) {
    return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  }
  const i18n = hint.i18n ? { i18n: mapStrings(hint.i18n, state.browserText) } : {};
  const content = state.browserText(hint.content);
  const existing = runtime.revealedHints.get(hint.id);
  if (existing) {
    return {
      status: StatusCodes.OK,
      body: {
        kind: "already_revealed",
        content,
        ...i18n,
        penaltyApplied: 0,
        totalScore: sessionScore(state),
        revealedAt: existing,
      },
    };
  }
  const penalty = applyPenalty(runtime, hint.penalty);
  runtime.revealedHints.set(hint.id, iso);
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
      content,
      ...i18n,
      penaltyApplied: penalty,
      totalScore: sessionScore(state),
      revealedAt: iso,
    },
  };
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
