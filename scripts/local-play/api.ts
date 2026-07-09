import { StatusCodes } from "http-status-codes";
import type { LocalComposeUnit, StartedContainer } from "./container-runner";
import type {
  ContainerCheck,
  ContainerHint,
  ContainerHintRevealMode,
  ContainerProblem,
} from "./manifest";
import { mapStrings, remapContainerProblem } from "./port-remap";
import { ProblemLifecycle, type ProblemStatus } from "./problem-lifecycle";
import { type VerifyContext, type VerifyResult, verifySubmission } from "./verify-client";

/**
 * The local scoring API. It owns the participant-facing portal contract (team
 * view, leaderboard, hints, score events) but holds NO answer: a flag
 * submission is delegated to the problem container's `/verify` and the verdict
 * is recorded. The platform never evaluates correctness itself (Issue #2054).
 *
 * [#2392] The API serves N problems in one session. All per-problem state is
 * keyed by `problemId` (a `runtimes` Map), so `/portal/me` returns every
 * problem and submit / reveal route to the addressed one. The single-problem
 * case is just a 1-entry map.
 *
 * [#2392 Phase 2] The session is warm: `deployment.problems` is the WHOLE
 * local-play catalog, but containers start on demand (`ProblemLifecycle` owns
 * the cap / LRU eviction / idle reaping). Docker is injected through
 * `CreateStateOptions.startContainer` / `stopContainer` — `serve` wires the
 * real `ContainerRunner` in; the default is a dockerless fake so the API is
 * unit-tested with no containers.
 */

export const LOCAL_CONTEXT = {
  eventId: "local",
  teamId: "local",
} as const;

export interface LocalPlayDeployment {
  /** [#2392] The full local-play catalog (order = portal display order). */
  readonly problems: readonly ContainerProblem[];
}

/** [#2392 Phase 2] 同時起動コンテナ数の既定キャップ / default cap on running containers. */
export const DEFAULT_MAX_RUNNING = 3;
/** [#2392 Phase 2] 無操作コンテナを回収するまでの既定時間 (15 分) / default idle-reap window. */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/** Injected docker start: bring `problem` up on `offset` and return the remapped problem + teardown unit. */
export type StartProblemContainer = (
  problem: ContainerProblem,
  offset: number,
) => Promise<StartedContainer>;

/** Injected docker stop: tear one started unit down (idempotent). */
export type StopProblemContainer = (unit: LocalComposeUnit) => void | Promise<void>;

export type VerifyFn = (
  verifyUrl: string,
  submission: string,
  context: VerifyContext,
  options?: { readonly checkpointId?: string },
) => Promise<VerifyResult>;

export interface LocalPlayScoreEvent {
  readonly jobId: string;
  readonly problemId: string;
  readonly source: "flag" | "flag-wrong" | "hint";
  readonly points: number;
  readonly result: "ok" | "wrong";
  readonly occurredAt: string;
}

/**
 * Per-problem runtime state. `solved` / `wrongCounts` keys are the submission
 * target (problemId for `verify`, check id for `multi-verify`); `revealedHints`
 * keys are hint ids (unique within a problem). `score` is this problem's running
 * score including hint / wrong-answer penalties.
 */
interface ProblemRuntime {
  /**
   * [#2392 Phase 2] The currently-active problem: the catalog original while
   * stopped, the offset-remapped copy while running. The offset moves every
   * loopback URL the problem mentions — `challengeEndpoints`, `verifyUrl`, and
   * the instructions / hints prose that quote them — onto the assigned port
   * block; points and answers never change.
   */
  problem: ContainerProblem;
  readonly solved: Set<string>;
  readonly revealedHints: Map<string, string>;
  readonly wrongCounts: Map<string, number>;
  score: number;
}

export interface LocalPlayState {
  /** Per-problem runtime keyed by problemId; insertion order is display order. */
  readonly runtimes: Map<string, ProblemRuntime>;
  /** Score events across all problems (each carries its own problemId). */
  readonly scoreEvents: LocalPlayScoreEvent[];
  readonly verify: VerifyFn;
  /** Browser-facing rewrite for loopback URLs in problem prose / endpoint outputs. */
  readonly browserText: (text: string) => string;
  /** [#2392 Phase 2] On-demand container lifecycle (cap / LRU eviction / idle reaping). */
  readonly lifecycle: ProblemLifecycle;
  teamName: string;
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
  /** [#2392 Phase 2] Max simultaneously-running containers (default {@link DEFAULT_MAX_RUNNING}). */
  readonly maxRunning?: number;
  /** [#2392 Phase 2] Idle window before a running container is reaped (default {@link DEFAULT_IDLE_MS}). */
  readonly idleMs?: number;
  /** Clock injected so cap / idle behavior is deterministic in tests. */
  readonly now?: () => number;
  /** Rewrite display-only local URLs for browser environments such as Codespaces. */
  readonly browserText?: (text: string) => string;
  /** Docker start seam; `serve` injects the real `ContainerRunner`. */
  readonly startContainer?: StartProblemContainer;
  /** Docker stop seam; `serve` injects the real `ContainerRunner`. */
  readonly stopContainer?: StopProblemContainer;
}

/**
 * [#2392 Phase 2] Default docker seam for tests: no container runs. "Starting"
 * a problem just moves its loopback URLs onto the assigned port block — the
 * same URL rewrite the real `ContainerRunner` applies — so the on-demand flow
 * is fully observable without Docker. 本番の `serve` は必ず実 Docker アダプタ
 * を注入する (この fake が production で動くことはない)。
 */
function fakeStartContainer(problem: ContainerProblem, offset: number): Promise<StartedContainer> {
  const portMap = new Map<number, number>();
  for (const url of [...Object.values(problem.challengeEndpoints), problem.verifyUrl]) {
    const port = Number(new URL(url).port);
    portMap.set(port, port + offset);
  }
  return Promise.resolve({
    problem: remapContainerProblem(problem, portMap),
    unit: {
      problemId: problem.problemId,
      composePath: problem.composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
    },
  });
}

export function createLocalPlayState(
  deployment: LocalPlayDeployment,
  options: CreateStateOptions = {},
): LocalPlayState {
  const runtimes = new Map<string, ProblemRuntime>();
  const catalog = new Map<string, ContainerProblem>();
  for (const problem of deployment.problems) {
    catalog.set(problem.problemId, problem);
    runtimes.set(problem.problemId, {
      problem,
      solved: new Set(),
      revealedHints: new Map(),
      wrongCounts: new Map(),
      score: 0,
    });
  }
  const startContainer = options.startContainer ?? fakeStartContainer;
  const stopContainer = options.stopContainer ?? (() => {});
  /** Teardown handle per running problem (the lifecycle only knows ids + offsets). */
  const units = new Map<string, LocalComposeUnit>();
  const lifecycle = new ProblemLifecycle(
    [...catalog.keys()],
    {
      // 起動: catalog 原本を offset へ remap して runtime に差し替える /
      // start the catalog original on its offset block and swap it in.
      startContainer: async (problemId, offset) => {
        const problem = catalog.get(problemId);
        const runtime = runtimes.get(problemId);
        if (!problem || !runtime) throw new Error(`unknown problem: ${problemId}`);
        const started = await startContainer(problem, offset);
        units.set(problemId, started.unit);
        runtime.problem = started.problem;
      },
      // 停止: unit を破棄して catalog 原本へ戻す / tear the unit down and
      // restore the catalog original (stale offset URLs must not linger).
      stopContainer: async (problemId) => {
        const unit = units.get(problemId);
        units.delete(problemId);
        if (unit) await stopContainer(unit);
        const problem = catalog.get(problemId);
        const runtime = runtimes.get(problemId);
        if (problem && runtime) runtime.problem = problem;
      },
      now: options.now ?? Date.now,
    },
    {
      maxRunning: options.maxRunning ?? DEFAULT_MAX_RUNNING,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
    },
  );
  return {
    runtimes,
    scoreEvents: [],
    verify: options.verify ?? verifySubmission,
    browserText: options.browserText ?? ((text) => text),
    lifecycle,
    teamName: options.teamName ?? "Local Player",
  };
}

/** Session total = sum of every problem's running score. */
function sessionScore(state: LocalPlayState): number {
  let total = 0;
  for (const rt of state.runtimes.values()) total += rt.score;
  return total;
}

/**
 * Identity check for the readiness probe: is the server answering `/healthz`
 * *our* local-play session serving (at least) `problemIds`? Guards against
 * silently adopting a foreign server squatting on the API port.
 */
export function isLocalApiHealthy(body: unknown, problemIds: readonly string[]): boolean {
  if (typeof body !== "object" || body === null) return false;
  const payload = body as { status?: unknown; mode?: unknown; problemIds?: unknown };
  if (payload.status !== "ok" || payload.mode !== "local") return false;
  if (!Array.isArray(payload.problemIds)) return false;
  const served = new Set(payload.problemIds.filter((id): id is string => typeof id === "string"));
  return problemIds.every((id) => served.has(id));
}

function hintViews(runtime: ProblemRuntime, hints: readonly ContainerHint[]) {
  return hints.map((hint) => {
    const revealedAt = runtime.revealedHints.get(hint.id);
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

/**
 * [#2252] multi-verify renders through the portal's existing multi-flag view:
 * each checkpoint becomes a `flags[]` entry ({ id, label, points, solved }) so
 * `MultiFlagSubmissionPanel` / `submitFlag(..., flagId)` are reused as-is — no
 * new portal scoring kind. Per-check hints ride on the optional `hints` field.
 */
function multiVerifyScoringView(
  runtime: ProblemRuntime,
  checks: readonly ContainerCheck[],
  totalPoints: number,
  hintReveal: ContainerHintRevealMode | undefined,
) {
  return {
    kind: "multi-flag",
    points: totalPoints,
    // 順序ゲートを外す flat の問題だけ露出 (既定 sequential は送らない)。 portal の
    // HintsPanel がこれを見て各 sub-flag の hint lock を外す。
    ...(hintReveal ? { hintReveal } : {}),
    flags: checks.map((check) => ({
      id: check.id,
      label: check.label,
      points: check.points,
      solved: runtime.solved.has(check.id),
      ...(check.i18n ? { i18n: check.i18n } : {}),
      ...(check.hints.length > 0 ? { hints: hintViews(runtime, check.hints) } : {}),
    })),
  };
}

/** Whether every submission target of a problem is solved (gates the writeup). */
function isProblemComplete(runtime: ProblemRuntime): boolean {
  const scoring = runtime.problem.scoring;
  if (scoring.kind === "verify") return runtime.solved.has(runtime.problem.problemId);
  return scoring.checks.every((check) => runtime.solved.has(check.id));
}

function problemView(
  runtime: ProblemRuntime,
  now: number,
  status: ProblemStatus,
  browserText: (text: string) => string,
) {
  const problem = mapStrings(runtime.problem, browserText);
  const complete = isProblemComplete(runtime);
  const englishText = {
    ...(problem.i18n?.en ?? {}),
    ...(complete && problem.writeupI18n ? { writeup: problem.writeupI18n } : {}),
  };
  return {
    jobId: jobIdOf(problem.problemId),
    problemId: problem.problemId,
    name: problem.name,
    description: problem.description,
    instructions: problem.instructions,
    // Local mode is a drill: reveal immediately after the whole problem is solved.
    ...(complete && problem.writeup ? { writeup: problem.writeup } : {}),
    // #2054 i18n: ship the en overlay so the portal locale switcher can render
    // the problem in English (ja stays the top-level canonical).
    ...(Object.keys(englishText).length > 0 ? { i18n: { en: englishText } } : {}),
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    // [#2392 Phase 2] on-demand container state — the portal renders its
    // start / stop affordance from this field.
    lifecycle: { status },
    // The challenge surface URLs the participant attacks (loopback only). A
    // stopped problem must not leak (stale) endpoints of a down container.
    stackOutputs: status === "running" ? problem.challengeEndpoints : {},
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    // [#2392] running per-problem score incl. hint / wrong-answer penalties (the
    // header total is the sum, matching the leaderboard).
    score: runtime.score,
    ...(complete ? { lastResult: "ok" as const } : {}),
    // Participant-facing view: single submission box ("flag") for verify, the
    // existing multi-flag shape for multi-verify. Scoring stays delegated.
    scoring:
      problem.scoring.kind === "verify"
        ? {
            kind: "flag",
            points: problem.scoring.points,
            flagSubmitted: complete,
            hints: hintViews(runtime, problem.scoring.hints),
            ...(problem.scoring.hintReveal ? { hintReveal: problem.scoring.hintReveal } : {}),
          }
        : multiVerifyScoringView(
            runtime,
            problem.scoring.checks,
            problem.scoring.totalPoints,
            problem.scoring.hintReveal,
          ),
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
      problems: [...state.runtimes.entries()].map(([problemId, runtime]) =>
        problemView(
          runtime,
          now,
          state.lifecycle.statusOf(problemId) ?? "stopped",
          state.browserText,
        ),
      ),
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

async function submitFlag(
  request: LocalPlayRequest,
  state: LocalPlayState,
  iso: string,
): Promise<LocalPlayResponse> {
  const body = (request.body ?? {}) as { problemId?: unknown; flag?: unknown; flagId?: unknown };
  const runtime =
    typeof body.problemId === "string" ? state.runtimes.get(body.problemId) : undefined;
  if (!runtime || typeof body.flag !== "string") {
    return { status: StatusCodes.BAD_REQUEST, body: { error: "invalid_flag" } };
  }
  const problem = runtime.problem;
  // [#2392 Phase 2] A stopped container cannot judge — refuse loudly instead of
  // timing out against a down /verify. Playing keeps the container warm (touch).
  if (state.lifecycle.statusOf(problem.problemId) !== "running") {
    return { status: StatusCodes.CONFLICT, body: { error: "not_running" } };
  }
  state.lifecycle.touch(problem.problemId);
  const target = resolveSubmissionTarget(runtime, body.flagId);
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
        ? await state.verify(problem.verifyUrl, body.flag, context, {
            checkpointId: target.checkpointId,
          })
        : await state.verify(problem.verifyUrl, body.flag, context);
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
    : recordWrong(state, runtime, target, iso, flagIdEcho);
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
  return {
    status: StatusCodes.OK,
    body: {
      kind: "wrong",
      scoreDelta,
      totalScore: sessionScore(state),
      wrongCount,
      ...flagIdField,
    },
  };
}

function revealHint(
  problemId: string,
  hintId: string,
  state: LocalPlayState,
  iso: string,
): LocalPlayResponse {
  const runtime = state.runtimes.get(problemId);
  if (!runtime) return { status: StatusCodes.NOT_FOUND, body: { error: "unknown_hint" } };
  // [#2392 Phase 2] Hints are part of playing the problem — gate on a running
  // container and keep it warm, matching submit.
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

function leaderboard(state: LocalPlayState): LocalPlayResponse {
  // [#2252/#2392] a multi-verify problem counts as complete only when every
  // checkpoint is solved; the session may hold several problems.
  const runtimes = [...state.runtimes.values()];
  const completed = runtimes.filter((rt) => isProblemComplete(rt)).length;
  return {
    status: StatusCodes.OK,
    body: {
      eventId: LOCAL_CONTEXT.eventId,
      entries: [
        {
          rank: 1,
          teamId: LOCAL_CONTEXT.teamId,
          teamName: state.teamName,
          score: sessionScore(state),
          completedProblems: completed,
          totalProblems: state.runtimes.size,
          isMyTeam: true,
        },
      ],
      scoreboardFrozen: false,
    },
  };
}

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
