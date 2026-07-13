import type { LocalComposeUnit, StartedContainer } from "./container-runner";
import type { ContainerProblem } from "./manifest";
import { remapContainerProblem } from "./port-remap";
import { ProblemLifecycle } from "./problem-lifecycle";
import type { SimulatedCloudProblem } from "./simulator";
import type { LocalSimulatorDeployment, LocalSimulatorRuntimePort } from "./simulator-runtime";
import {
  type SimulatorDeploymentScoringState,
  type SimulatorScoringContract,
  simulatorScoringContract,
} from "./simulator-scoring";
import { type VerifyContext, type VerifyResult, verifySubmission } from "./verify-client";

/**
 * [#2527 Slice 6] The local scoring API's contract + session state, extracted verbatim
 * from `api.ts`: the participant-facing shapes (deployment / state / request / response /
 * score events), the docker seams, and `createLocalPlayState` (the warm-session factory
 * wiring `ProblemLifecycle` to the injected container adapter). Views live in
 * `api-views.ts`, submission scoring in `api-scoring.ts`, routing in `api.ts`.
 */

export const LOCAL_CONTEXT = {
  eventId: "local",
  teamId: "local",
} as const;

export interface LocalPlayDeployment {
  /** [#2392] The full local-play catalog (order = portal display order). */
  readonly problems: readonly ContainerProblem[];
  /** Cloud and Composite descriptors delegated to TenkaCloud Simulator. */
  readonly simulatedProblems?: readonly SimulatedCloudProblem[];
}

/** [#2392 Phase 2] 同時起動コンテナ数の既定キャップ / default cap on running containers. */
export const DEFAULT_MAX_RUNNING = 3;

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
  readonly source: "flag" | "flag-wrong" | "hint" | "uptime" | "attack-detected";
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
export interface ProblemRuntime {
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

export interface SimulatedProblemRuntime {
  readonly problem: SimulatedCloudProblem;
  readonly contract: SimulatorScoringContract;
  readonly overrides: Map<string, string>;
  readonly solved: Set<string>;
  readonly revealedHints: Map<string, string>;
  readonly wrongCounts: Map<string, number>;
  deployment?: LocalSimulatorDeployment;
  createdAt?: string;
  scoringState: SimulatorDeploymentScoringState;
  endpointsHealth?: string;
  attackProbes?: string;
  posture?: string;
  platform?: string;
  lastResult?: "ok" | "fail";
  score: number;
}

export interface LocalPlayState {
  /** Per-problem runtime keyed by problemId; insertion order is display order. */
  readonly runtimes: Map<string, ProblemRuntime>;
  readonly simulatedRuntimes: Map<string, SimulatedProblemRuntime>;
  /** Per-problem Simulator score cycle shared by start, explicit score, and the periodic timer. */
  readonly simulatorScoringInFlight: Map<string, Promise<LocalPlayResponse>>;
  /** Score events across all problems (each carries its own problemId). */
  readonly scoreEvents: LocalPlayScoreEvent[];
  readonly verify: VerifyFn;
  /** Browser-facing rewrite for loopback URLs in problem prose / endpoint outputs. */
  readonly browserText: (text: string) => string;
  /** [#2392 Phase 2] On-demand container lifecycle (cap / LRU eviction; explicit stop only, #2512). */
  readonly lifecycle: ProblemLifecycle;
  readonly simulator?: LocalSimulatorRuntimePort;
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

export const jobIdOf = (problemId: string) => `local-${problemId}`;

export interface CreateStateOptions {
  readonly teamName?: string;
  readonly verify?: VerifyFn;
  /** [#2392 Phase 2] Max simultaneously-running containers (default {@link DEFAULT_MAX_RUNNING}). */
  readonly maxRunning?: number;
  /** Clock injected so cap / LRU-eviction behavior is deterministic in tests. */
  readonly now?: () => number;
  /** Rewrite display-only local URLs for browser environments such as Codespaces. */
  readonly browserText?: (text: string) => string;
  /** Docker start seam; `serve` injects the real `ContainerRunner`. */
  readonly startContainer?: StartProblemContainer;
  /** Docker stop seam; `serve` injects the real `ContainerRunner`. */
  readonly stopContainer?: StopProblemContainer;
  /** Real provider-neutral Simulator lifecycle port. Required only when a cloud problem is started. */
  readonly simulator?: LocalSimulatorRuntimePort;
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
  const simulatedRuntimes = new Map<string, SimulatedProblemRuntime>();
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
  for (const problem of deployment.simulatedProblems ?? []) {
    if (catalog.has(problem.problemId) || simulatedRuntimes.has(problem.problemId)) {
      throw new Error(`duplicate local problem id: ${problem.problemId}`);
    }
    simulatedRuntimes.set(problem.problemId, {
      problem,
      contract: simulatorScoringContract(problem),
      overrides: new Map(),
      solved: new Set(),
      revealedHints: new Map(),
      wrongCounts: new Map(),
      scoringState: {},
      score: 0,
    });
  }
  const startContainer = options.startContainer ?? fakeStartContainer;
  const stopContainer = options.stopContainer ?? (() => {});
  const now = options.now ?? Date.now;
  /** Teardown handle per running problem (the lifecycle only knows ids + offsets). */
  const units = new Map<string, LocalComposeUnit>();
  const lifecycle = new ProblemLifecycle(
    [...catalog.keys(), ...simulatedRuntimes.keys()],
    {
      // 起動: catalog 原本を offset へ remap して runtime に差し替える /
      // start the catalog original on its offset block and swap it in.
      startContainer: async (problemId, offset) => {
        const simulatedRuntime = simulatedRuntimes.get(problemId);
        if (simulatedRuntime) {
          if (!options.simulator) {
            throw new Error("Cloud local play requires a configured TenkaCloud Simulator runtime");
          }
          simulatedRuntime.deployment = await options.simulator.start(simulatedRuntime.problem);
          simulatedRuntime.createdAt ??= new Date(now()).toISOString();
          return;
        }
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
        const simulatedRuntime = simulatedRuntimes.get(problemId);
        if (simulatedRuntime) {
          if (options.simulator) await options.simulator.stop(problemId);
          simulatedRuntime.deployment = undefined;
          return;
        }
        const unit = units.get(problemId);
        units.delete(problemId);
        if (unit) await stopContainer(unit);
        const problem = catalog.get(problemId);
        const runtime = runtimes.get(problemId);
        if (problem && runtime) runtime.problem = problem;
      },
      now,
    },
    { maxRunning: options.maxRunning ?? DEFAULT_MAX_RUNNING },
  );
  return {
    runtimes,
    simulatedRuntimes,
    simulatorScoringInFlight: new Map(),
    scoreEvents: [],
    verify: options.verify ?? verifySubmission,
    browserText: options.browserText ?? ((text) => text),
    lifecycle,
    ...(options.simulator ? { simulator: options.simulator } : {}),
    teamName: options.teamName ?? "Local Player",
  };
}

/** Session total = sum of every problem's running score. */
export function sessionScore(state: LocalPlayState): number {
  let total = 0;
  for (const rt of state.runtimes.values()) total += rt.score;
  for (const rt of state.simulatedRuntimes.values()) total += rt.score;
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
