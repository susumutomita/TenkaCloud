import { randomBytes } from "node:crypto";
import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
import {
  ContainerStartOwnershipError,
  type LocalComposeUnit,
  type StartedContainer,
} from "./container-runner";
import type { ContainerProblem } from "./manifest";
import { createNativeCompatibilityGate } from "./native-compatibility";
import { remapContainerProblem } from "./port-remap";
import { type LifecycleDeps, ProblemLifecycle } from "./problem-lifecycle";
import { ProblemTerminals, type TerminalDeps, type TerminalProcess } from "./problem-terminal";
import type { SimulatedCloudProblem } from "./simulator";
import type { LocalSimulatorDeployment, LocalSimulatorRuntimePort } from "./simulator-runtime";
import {
  type SimulatorDeploymentScoringState,
  type SimulatorScoringContract,
  simulatorScoringContract,
} from "./simulator-scoring";
import { type VerifyContext, type VerifyResult, verifySubmission } from "./verify-client";
import { requestWorkbench, type WorkbenchFn } from "./workbench-client";

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
  /** Random bearer generated for this local session's sensitive participant handoffs. */
  readonly participantToken?: string;
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
  /** Short-lived, single-use tickets that exchange an authenticated request for a browser redirect. */
  readonly consoleHandoffs: Map<
    string,
    {
      readonly problemId: string;
      readonly deploymentId: string;
      readonly expiresAtMs: number;
    }
  >;
  /**
   * [#2846] Short-lived, single-use tickets that exchange an authenticated POST for one
   * terminal WebSocket upgrade. Same shape and lifetime as {@link consoleHandoffs}: the
   * upgrade carries no Authorization header a browser can set, so the ticket *is* the
   * credential and must not survive its first redemption.
   */
  readonly terminalHandoffs: Map<
    string,
    {
      readonly problemId: string;
      readonly expiresAtMs: number;
    }
  >;
  /** [#2846] Interactive container shells, keyed by problem. Never outlive their container. */
  readonly terminals: ProblemTerminals;
  /** Score events across all problems (each carries its own problemId). */
  readonly scoreEvents: LocalPlayScoreEvent[];
  readonly verify: VerifyFn;
  /** Authenticated proxy seam for the running container's generic editor contract. */
  readonly workbench: WorkbenchFn;
  /** Browser-facing rewrite for loopback URLs in problem prose / endpoint outputs. */
  readonly browserText: (text: string) => string;
  /** [#2392 Phase 2] On-demand container lifecycle (cap / LRU eviction; explicit stop only, #2512). */
  readonly lifecycle: ProblemLifecycle;
  readonly simulator?: LocalSimulatorRuntimePort;
  /** Server-owned directory for operator snapshot export/import. */
  readonly simulatorSnapshotDir?: string;
  readonly participantToken: string;
  /**
   * [#2925 / #2926] The participant-facing problem catalog served at
   * `/portal/problem-catalog`. Already projected through `metadataToEntry`, so no raw
   * `metadata.json` field (notably the spoiler-bearing `description`) can reach the wire.
   * Empty for sessions that never loaded one (unit tests, simulator-only).
   */
  readonly problemCatalog: readonly ProblemCatalogEntry[];
  teamName: string;
}

export interface LocalPlayRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorization?: string;
}

export interface LocalPlayResponse {
  readonly status: number;
  readonly body: unknown;
  /** Non-JSON response metadata used only for explicit browser handoffs. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const jobIdOf = (problemId: string) => `local-${problemId}`;

export interface CreateStateOptions {
  readonly teamName?: string;
  readonly verify?: VerifyFn;
  /** Injectable editor client for API tests; production uses the loopback-only client. */
  readonly workbench?: WorkbenchFn;
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
  /** [#2846] Container-shell seam; `serve` injects the real `compose exec` spawner. */
  readonly spawnShell?: TerminalDeps["spawnShell"];
  /** Real provider-neutral Simulator lifecycle port. Required only when a cloud problem is started. */
  readonly simulator?: LocalSimulatorRuntimePort;
  /** Server-owned directory for Simulator snapshots; never accepted from an HTTP request. */
  readonly simulatorSnapshotDir?: string;
  /**
   * [#2927] Reports host ports a problem's offset would need that something else already
   * holds, so a previous session's leftover container is skipped rather than crashed into.
   */
  readonly portConflicts?: LifecycleDeps["portConflicts"];
  /**
   * [#3008] Refuses to start a problem whose declared `runtime.compatibility` this host
   * cannot satisfy. Omitted here means "not wired" (tests, simulator-only sessions);
   * `serve` builds it from the catalog, and a catalog declaring nothing never probes.
   */
  readonly nativeCompatibility?: LifecycleDeps["nativeCompatibility"];
  /**
   * [#2925 / #2926] Participant-facing catalog served at `/portal/problem-catalog`,
   * already projected by `metadataToEntry`. `serve` loads it from the bind-mounted
   * `problems/`; tests and simulator-only sessions may omit it (route answers empty).
   */
  readonly problemCatalog?: readonly ProblemCatalogEntry[];
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

/**
 * [#2846] Default shell seam: there is no container to exec into. `attach` turns the
 * throw into `spawn_failed`, so a test (or a misconfigured process) that never injected
 * a real spawner gets a refused terminal rather than a silently dead one. 本番の `serve`
 * は必ず実 `compose exec` アダプタを注入する。
 */
function fakeSpawnShell(problemId: string): TerminalProcess {
  throw new Error(`no container shell adapter configured for problem ${problemId}`);
}

interface RuntimeCollections {
  readonly runtimes: Map<string, ProblemRuntime>;
  readonly simulatedRuntimes: Map<string, SimulatedProblemRuntime>;
  readonly catalog: Map<string, ContainerProblem>;
}

function createRuntimeCollections(deployment: LocalPlayDeployment): RuntimeCollections {
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
  return { runtimes, simulatedRuntimes, catalog };
}

interface LifecycleContext extends RuntimeCollections {
  readonly simulator?: LocalSimulatorRuntimePort;
  readonly startContainer: StartProblemContainer;
  readonly stopContainer: StopProblemContainer;
  readonly now: () => number;
  readonly units: Map<string, LocalComposeUnit>;
  readonly terminals: ProblemTerminals;
}

function resetSimulatedRuntime(
  runtime: SimulatedProblemRuntime,
  deployment: LocalSimulatorDeployment,
  now: number,
): void {
  // A fresh world resets phase timing and world-scoped telemetry. Session
  // score, solved history, one-time awards/disruptions, and participant
  // overrides stay cumulative so reset cannot be used to farm points.
  const priorScoringState = runtime.scoringState;
  runtime.deployment = deployment;
  runtime.createdAt = new Date(now).toISOString();
  runtime.scoringState = {
    ...(priorScoringState.bonusAwarded ? { bonusAwarded: priorScoringState.bonusAwarded } : {}),
    ...(priorScoringState.firedDisruptions
      ? { firedDisruptions: priorScoringState.firedDisruptions }
      : {}),
  };
  runtime.endpointsHealth = undefined;
  runtime.attackProbes = undefined;
  runtime.posture = undefined;
  runtime.platform = undefined;
  runtime.lastResult = undefined;
}

async function startLifecycleProblem(
  context: LifecycleContext,
  problemId: string,
  offset: number,
): Promise<void> {
  const simulatedRuntime = context.simulatedRuntimes.get(problemId);
  if (simulatedRuntime) {
    if (!context.simulator) {
      throw new Error("Cloud local play requires a configured TenkaCloud Simulator runtime");
    }
    const deployment = await context.simulator.start(simulatedRuntime.problem);
    resetSimulatedRuntime(simulatedRuntime, deployment, context.now());
    return;
  }
  const problem = context.catalog.get(problemId);
  const runtime = context.runtimes.get(problemId);
  if (!problem || !runtime) throw new Error(`unknown problem: ${problemId}`);
  let started: StartedContainer;
  try {
    started = await context.startContainer(problem, offset);
  } catch (error) {
    if (error instanceof ContainerStartOwnershipError) {
      context.units.set(problemId, error.unit);
    }
    throw error;
  }
  context.units.set(problemId, started.unit);
  runtime.problem = started.problem;
}

async function stopLifecycleProblem(context: LifecycleContext, problemId: string): Promise<void> {
  // [#2846] Explicit stop and LRU eviction both land here, and both reclaim the
  // container. A shell must never outlive it, so the sessions die first — after the
  // container is gone they would sit writing into a socket the participant still
  // believes is live.
  context.terminals.closeProblem(problemId);
  const simulatedRuntime = context.simulatedRuntimes.get(problemId);
  if (simulatedRuntime) {
    if (context.simulator) await context.simulator.stop(problemId);
    simulatedRuntime.deployment = undefined;
    return;
  }
  const unit = context.units.get(problemId);
  if (unit) await context.stopContainer(unit);
  context.units.delete(problemId);
  const problem = context.catalog.get(problemId);
  const runtime = context.runtimes.get(problemId);
  if (problem && runtime) runtime.problem = problem;
}

/**
 * The lifecycle's injected side. Split out of {@link createLocalPlayState} so the factory
 * stays readable — and so the [#2927] port probe, which only `serve` supplies, is optional
 * in exactly one place instead of being another conditional in a long object literal.
 */
function buildLifecycleDeps(
  context: LifecycleContext,
  now: () => number,
  portConflicts: LifecycleDeps["portConflicts"],
  nativeCompatibility?: LifecycleDeps["nativeCompatibility"],
): LifecycleDeps {
  return {
    // 起動: catalog 原本を offset へ remap して runtime に差し替える /
    // start the catalog original on its offset block and swap it in.
    startContainer: (problemId, offset) => startLifecycleProblem(context, problemId, offset),
    // 停止: unit を破棄して catalog 原本へ戻す / tear the unit down and
    // restore the catalog original (stale offset URLs must not linger).
    stopContainer: (problemId) => stopLifecycleProblem(context, problemId),
    now,
    ...(portConflicts ? { portConflicts } : {}),
    ...(nativeCompatibility ? { nativeCompatibility } : {}),
  };
}

export function createLocalPlayState(
  deployment: LocalPlayDeployment,
  options: CreateStateOptions = {},
): LocalPlayState {
  const participantToken = deployment.participantToken ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(participantToken)) {
    throw new Error("Local participant token must be 32-byte base64url");
  }
  const { runtimes, simulatedRuntimes, catalog } = createRuntimeCollections(deployment);
  const startContainer = options.startContainer ?? fakeStartContainer;
  const stopContainer =
    options.stopContainer ??
    (() => {
      // Default for callers with no container runtime (tests, simulator-only sessions):
      // there is nothing to tear down, so "stopped" is already true.
    });
  const now = options.now ?? Date.now;
  /** Teardown handle per running problem (the lifecycle only knows ids + offsets). */
  const units = new Map<string, LocalComposeUnit>();
  // [#2846] terminals ↔ lifecycle is mutually recursive (a shell may only attach to a
  // `running` container; a stopping container must kill its shells), so the back edge
  // is a closure over `lifecycle` rather than a constructor argument. [#2850] Only
  // problems whose metadata opts into `runtime.terminal` are shell-able — a
  // simulated-cloud problem has no container to exec into, and a container problem
  // that never declared a terminal must be refused even here, behind the ticket gate.
  const terminalProblemIds = new Set(
    [...catalog.values()].filter((problem) => problem.terminal).map((p) => p.problemId),
  );
  const terminals = new ProblemTerminals(terminalProblemIds, {
    spawnShell: options.spawnShell ?? fakeSpawnShell,
    statusOf: (problemId) => lifecycle.statusOf(problemId),
  });
  const lifecycleContext: LifecycleContext = {
    runtimes,
    simulatedRuntimes,
    catalog,
    ...(options.simulator ? { simulator: options.simulator } : {}),
    startContainer,
    stopContainer,
    now,
    units,
    terminals,
  };
  const lifecycle = new ProblemLifecycle(
    [...catalog.keys(), ...simulatedRuntimes.keys()],
    buildLifecycleDeps(
      lifecycleContext,
      now,
      options.portConflicts,
      options.nativeCompatibility ??
        createNativeCompatibilityGate((problemId) => catalog.get(problemId)?.compatibility),
    ),
    { maxRunning: options.maxRunning ?? DEFAULT_MAX_RUNNING },
  );
  return {
    runtimes,
    simulatedRuntimes,
    simulatorScoringInFlight: new Map(),
    consoleHandoffs: new Map(),
    terminalHandoffs: new Map(),
    terminals,
    scoreEvents: [],
    verify: options.verify ?? verifySubmission,
    workbench: options.workbench ?? requestWorkbench,
    browserText: options.browserText ?? ((text) => text),
    lifecycle,
    ...(options.simulator ? { simulator: options.simulator } : {}),
    ...(options.simulatorSnapshotDir ? { simulatorSnapshotDir: options.simulatorSnapshotDir } : {}),
    participantToken,
    problemCatalog: options.problemCatalog ?? [],
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
