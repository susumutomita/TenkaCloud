import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCodePoints } from "./lib/code-point-order";
import { scoreSimulatedProblem } from "./local-play/api-scoring";
import type { LocalPlayDeployment } from "./local-play/api-state";
import {
  autoInitProblemsSubmodule,
  loadLocalPlayCatalog,
  loadProblemCatalogEntries,
  pinIntroDrillFirst,
  problemSearchRoots,
} from "./local-play/catalog-loader";
import { browserDisplayText, buildLocalRuntimeConfig } from "./local-play/codespaces-links";
import { ContainerStartOwnershipError, type LocalComposeUnit } from "./local-play/container-runner";
import { parseProblemIds } from "./local-play/deployment-plan";
import {
  createContainerRunner,
  createPortConflictProbe,
  createProblemShellSpawner,
  startDetachedServe,
  waitForReachable,
} from "./local-play/docker-adapter";
import {
  assertDockerAvailable,
  persistStartedContainerUnit,
  positivePort,
  printRunningEndpoints,
  privateLocalPaths,
  recordedApiIsHealthy,
  requiredLocalApiPort,
  SERVE_SHUTDOWN_TIMEOUT_MS,
  shutdownLocalServe,
  startProblemViaApi,
  stopPersistedContainerUnit,
  tearDownRecordedUnits,
  waitForProblemRunning,
  waitForServeProcessExit,
} from "./local-play/local-runtime-support";
import { type LocalPlayProblemSummary, listLocalPlayProblems } from "./local-play/manifest";
import { createNativeCompatibilityGate } from "./local-play/native-compatibility";
import { observeProcessIdentity } from "./local-play/process-identity";
import { assertPortFree, freeLoopbackPort, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import {
  type LocalProcessState,
  type RecordedUnits,
  readLocalProcessState,
  readPrivateJson,
  reclaimStaleSession,
  releaseSessionState,
  restoreRuntimeConfig,
  stopRecordedProcess,
  stopRecordedServeProcess,
  unlinkIfExists,
  writePrivateJson,
} from "./local-play/session-state";
import {
  enabledSimulatedCloudProblems,
  enabledSimulatedCloudSummaries,
} from "./local-play/simulator";
import {
  cleanupRecordedSimulatorSession,
  SimulatorLocalRuntime,
} from "./local-play/simulator-runtime";
import {
  clearLocalPlayStateStore,
  localPlayDatabaseBackend,
  openLocalPlayStateStore,
} from "./local-play/state-store-factory";

/**
 * [#2527 Slice 6] The local-play CLI entrypoint: command routing + composition only.
 * The four concern layers live in `scripts/local-play/` — `docker-adapter.ts`
 * (process/container adapter), `session-state.ts` (on-disk session state),
 * `codespaces-links.ts` (browser URL presentation), `catalog-loader.ts` (catalog) —
 * and the commands below orchestrate them.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type LocalPaths = ReturnType<typeof privateLocalPaths>;
type ContainerCatalog = ReturnType<typeof loadLocalPlayCatalog>;
type SimulatorCatalog = ReturnType<typeof enabledSimulatedCloudProblems>;

interface LocalStartupPlan {
  readonly paths: LocalPaths;
  readonly problemIds: string[];
  readonly apiPort: number;
  readonly apiBaseUrl: string;
  readonly catalog: ContainerCatalog;
  readonly simulatedCatalog: SimulatorCatalog;
}

interface ApiProcessOwnership {
  pid?: number;
  processIdentity?: string;
}

async function reclaimPreviousLocalSession(paths: LocalPaths): Promise<void> {
  await reclaimStaleSession(
    paths.statePath,
    () => readLocalProcessState(paths.statePath, paths),
    recordedApiIsHealthy,
    async (state) => {
      stopRecordedServeProcess(state);
      if (
        !(await waitForServeProcessExit(
          state.pid,
          state.processIdentity,
          SERVE_SHUTDOWN_TIMEOUT_MS,
        ))
      ) {
        throw new Error(
          "Previous local-play serve process did not stop; refusing concurrent cleanup",
        );
      }
      await cleanupRecordedSimulatorSession(paths.simulatorSessionPath);
      releaseSessionState(paths, state);
    },
  );
}

function assertRequestedProblemsExist(
  problemIds: readonly string[],
  roots: readonly string[],
  catalog: ContainerCatalog,
  simulatedCatalog: SimulatorCatalog,
): void {
  const catalogIds = new Set([...catalog, ...simulatedCatalog].map((problem) => problem.problemId));
  for (const id of problemIds) {
    if (!catalogIds.has(id)) {
      throw new Error(`problem "${id}" was not found under: ${roots.join(", ")}`);
    }
  }
}

async function prepareLocalStartup(
  problemArg: string,
  paths: LocalPaths,
): Promise<LocalStartupPlan> {
  const problemIds = parseProblemIds(problemArg);
  const apiPort = process.env.LOCAL_API_PORT
    ? positivePort(process.env.LOCAL_API_PORT, 1, "LOCAL_API_PORT")
    : await freeLoopbackPort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  if (process.env.LOCAL_API_PORT) await assertPortFree(apiPort, "Participant API");
  // Leftover containers from a crashed session would collide with this one on
  // the same port blocks — reclaim them first (idempotent).
  tearDownRecordedUnits(paths);

  // [#2392 Phase 2] Warm session: the API serves the WHOLE local-play catalog
  // and containers start on demand. PROBLEM= only selects what to pre-start —
  // none means a warm session with zero containers.
  const roots = problemSearchRoots(REPO_ROOT);
  const catalog = loadLocalPlayCatalog(REPO_ROOT, roots);
  // [#2632] Simulator problems are OFF by default (opt in: TENKACLOUD_LOCAL_SIMULATOR=1).
  const simulatedCatalog = enabledSimulatedCloudProblems(roots);
  assertRequestedProblemsExist(problemIds, roots, catalog, simulatedCatalog);
  const containerIds = new Set(catalog.map((problem) => problem.problemId));
  if (problemIds.length === 0 || problemIds.some((id) => containerIds.has(id))) {
    assertDockerAvailable();
  }
  return { paths, problemIds, apiPort, apiBaseUrl, catalog, simulatedCatalog };
}

function backupRuntimeConfig(paths: LocalPaths): boolean {
  if (existsSync(paths.runtimeConfigBackupPath)) {
    // An orphaned backup from a crashed run holds the real original — adopt it
    // rather than overwriting it with the (possibly stale local) live config.
    return true;
  }
  if (!existsSync(paths.runtimeConfigPath)) return false;
  copyFileSync(paths.runtimeConfigPath, paths.runtimeConfigBackupPath);
  return true;
}

async function printLocalStartupSuccess(
  plan: LocalStartupPlan,
  participantToken: string,
): Promise<void> {
  const catalogSize = plan.catalog.length + plan.simulatedCatalog.length;
  console.log(
    `Local play is ready (catalog: ${catalogSize} problem${catalogSize > 1 ? "s" : ""}, ` +
      `${plan.problemIds.length} pre-started).`,
  );
  console.log(`Participant API: ${plan.apiBaseUrl}`);
  await printRunningEndpoints(plan.apiBaseUrl, participantToken);
  if (plan.problemIds.length === 0) {
    console.log(
      "No problem was pre-started; run `tenkacloud local --problem <id>` or start one from the portal.",
    );
  }
  console.log(
    "Started containers keep running until you stop them: use the portal Stop button " +
      "for one problem, or `tenkacloud local down` to stop everything.",
  );
  console.log(
    "Participant Portal opens from `tenkacloud local`; after `tenkacloud local up`, run `tenkacloud local portal`.",
  );
}

async function startLocalSession(
  plan: LocalStartupPlan,
  runtimeConfigBackedUp: boolean,
  ownership: ApiProcessOwnership,
): Promise<void> {
  const participantToken = randomBytes(32).toString("base64url");
  const deployment: LocalPlayDeployment = {
    problems: plan.catalog,
    simulatedProblems: plan.simulatedCatalog,
    participantToken,
  };
  writePrivateJson(plan.paths.deploymentPath, deployment);
  ownership.pid = startDetachedServe(plan.paths.deploymentPath, plan.apiPort, plan.paths.logPath);
  ownership.processIdentity = observeProcessIdentity(ownership.pid);
  if (!ownership.processIdentity) {
    throw new Error("Local Participant API process identity could not be recorded");
  }
  const state: LocalProcessState = {
    pid: ownership.pid,
    processIdentity: ownership.processIdentity,
    apiBaseUrl: plan.apiBaseUrl,
    problemIds: plan.problemIds,
    deploymentPath: plan.paths.deploymentPath,
    runtimeConfigPath: plan.paths.runtimeConfigPath,
    participantToken,
    databaseBackend: localPlayDatabaseBackend(process.env),
    ...(runtimeConfigBackedUp
      ? { runtimeConfigBackupPath: plan.paths.runtimeConfigBackupPath }
      : {}),
  };
  // Commit ownership before any pre-start or runtime-config side effect. A
  // parent crash from this point is recoverable by the next up/down command.
  writePrivateJson(plan.paths.statePath, state);
  await waitForLocalApi(plan.apiBaseUrl, plan.problemIds, ownership.pid, plan.paths.logPath);
  // Pre-start through the API so the serve process owns every lifecycle.
  // start は 202 (async) で返るため、 endpoints 表示前に running まで待つ。
  for (const id of plan.problemIds) {
    await startProblemViaApi(plan.apiBaseUrl, id, participantToken);
    console.log(`Waiting for problem "${id}" (first start may build its container image)...`);
    await waitForProblemRunning(plan.apiBaseUrl, id, participantToken);
  }
  const runtimeConfig = buildLocalRuntimeConfig(plan.apiBaseUrl, participantToken);
  writeFileSync(
    plan.paths.runtimeConfigPath,
    `${JSON.stringify(runtimeConfig, null, 2)}\n`,
    "utf8",
  );
  await printLocalStartupSuccess(plan, participantToken);
}

async function stopFailedApiProcess(ownership: ApiProcessOwnership): Promise<boolean> {
  if (ownership.pid === undefined) return true;
  ownership.processIdentity ??= observeProcessIdentity(ownership.pid);
  stopRecordedProcess(ownership.pid, ownership.processIdentity, "Local-play serve");
  const exited = await waitForServeProcessExit(
    ownership.pid,
    ownership.processIdentity,
    SERVE_SHUTDOWN_TIMEOUT_MS,
  );
  if (!exited)
    throw new Error("Local-play serve process did not stop; refusing concurrent cleanup");
  return true;
}

async function cleanupFailedLocalStartup(
  error: unknown,
  paths: LocalPaths,
  ownership: ApiProcessOwnership,
): Promise<never> {
  const errors: unknown[] = [error];
  let serveExited = false;
  try {
    serveExited = await stopFailedApiProcess(ownership);
  } catch (shutdownError) {
    errors.push(shutdownError);
  }
  if (serveExited) {
    try {
      await cleanupRecordedSimulatorSession(paths.simulatorSessionPath);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    unlinkIfExists(paths.deploymentPath);
    unlinkIfExists(paths.statePath);
    restoreRuntimeConfig(paths.runtimeConfigBackupPath, paths.runtimeConfigPath, true);
    tearDownRecordedUnits(paths);
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Local play startup failed and cleanup was incomplete");
  }
  throw error;
}

async function up(problemArg: string): Promise<void> {
  const paths = privateLocalPaths();
  await reclaimPreviousLocalSession(paths);
  const plan = await prepareLocalStartup(problemArg, paths);
  const runtimeConfigBackedUp = backupRuntimeConfig(paths);
  const ownership: ApiProcessOwnership = {};
  try {
    await startLocalSession(plan, runtimeConfigBackedUp, ownership);
  } catch (error) {
    await cleanupFailedLocalStartup(error, paths, ownership);
  }
}

/**
 * [#2906] Container entrypoint. `up` detaches `serve` as a tracked background
 * process and returns — the right shape for a host CLI command, the wrong shape
 * for a container's PID 1, which must stay in the foreground so `docker stop` /
 * `docker compose down` deliver SIGTERM to it directly (that signal is what
 * `serve`'s own shutdown handler uses to stop every running problem container
 * and persist state — see the `process.once("SIGTERM", ...)` below). This
 * collapses `up`'s catalog-loading + deployment setup with an in-process `serve`
 * call, skipping the detach/PID-tracking/pre-start machinery that only a host
 * multi-invocation CLI session needs. Problems always start on demand from the
 * portal (no PROBLEM= pre-start) — same as a warm `tenkacloud local up` session
 * with none pre-started.
 */
async function containerServe(): Promise<void> {
  const paths = privateLocalPaths();
  await reclaimPreviousLocalSession(paths);
  const plan = await prepareLocalStartup("", paths);
  const deployment: LocalPlayDeployment = {
    problems: plan.catalog,
    simulatedProblems: plan.simulatedCatalog,
    participantToken: randomBytes(32).toString("base64url"),
  };
  writePrivateJson(paths.deploymentPath, deployment);
  await serve(paths.deploymentPath);
}

/**
 * [#2925 / #2926] Project the on-disk `problems/` catalog for `/portal/problem-catalog`.
 *
 * A problem whose metadata.json cannot be projected is reported rather than dropped in
 * silence: from the portal it would be indistinguishable from a problem nobody wrote, and
 * the participant would simply see a course track missing a week.
 */
function loadServedProblemCatalog() {
  const { entries, skipped } = loadProblemCatalogEntries(problemSearchRoots(REPO_ROOT));
  for (const { problemId, reason } of skipped) {
    console.warn(`Skipped ${problemId} in the portal catalog: ${reason}`);
  }
  return entries;
}

async function serve(deploymentPath: string): Promise<void> {
  if (!existsSync(deploymentPath)) {
    throw new Error(`Local deployment state was not found: ${deploymentPath}`);
  }
  const p = privateLocalPaths();
  if (resolve(deploymentPath) !== resolve(p.deploymentPath)) {
    throw new Error("Local deployment path is outside the owned local state");
  }
  const deploymentValue = readPrivateJson<unknown>(deploymentPath, 16 * 1024 * 1024);
  if (
    typeof deploymentValue !== "object" ||
    deploymentValue === null ||
    Array.isArray(deploymentValue) ||
    !("problems" in deploymentValue) ||
    !Array.isArray(deploymentValue.problems) ||
    ("simulatedProblems" in deploymentValue &&
      deploymentValue.simulatedProblems !== undefined &&
      !Array.isArray(deploymentValue.simulatedProblems)) ||
    !("participantToken" in deploymentValue) ||
    typeof deploymentValue.participantToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(deploymentValue.participantToken)
  ) {
    throw new Error("Local deployment state is invalid");
  }
  const deployment = deploymentValue as LocalPlayDeployment;
  const port = requiredLocalApiPort(process.env.LOCAL_API_PORT);
  const workloadImages = [
    ...new Set(
      (deployment.simulatedProblems ?? []).flatMap(
        (problem) => problem.simulationOverlay?.workloads?.map((workload) => workload.image) ?? [],
      ),
    ),
  ].sort(compareCodePoints);

  // [#2392 Phase 2] On-demand docker: the API's lifecycle drives the real
  // ContainerRunner, and every start/stop is mirrored to units.json so `down`
  // (a separate process) can reclaim the containers even after a crash.
  const runner = createContainerRunner(p.localDir);
  const simulator = new SimulatorLocalRuntime({
    sessionPath: p.simulatorSessionPath,
    stateDir: p.simulatorStateDir,
    logPath: p.simulatorLogPath,
    workloadImages,
    participantEnvPath: p.simulatorEnvPath,
    nativeProxyBaseUrl: `http://127.0.0.1:${port}`,
  });
  const units = new Map<string, LocalComposeUnit>();
  const persistUnits = (): void => {
    writePrivateJson(p.unitsPath, { units: [...units.values()] } satisfies RecordedUnits);
  };
  const stateStore = await openLocalPlayStateStore(p);
  const server = await startLocalPlayServer(port, deployment, {
    browserText: browserDisplayText,
    startContainer: async (problem, offset) => {
      try {
        const started = await runner.start(problem, offset);
        persistStartedContainerUnit(units, persistUnits, started.unit);
        return started;
      } catch (error) {
        if (error instanceof ContainerStartOwnershipError) {
          units.set(error.unit.problemId, error.unit);
          try {
            persistUnits();
          } catch (persistError) {
            throw new ContainerStartOwnershipError(error.unit, [error, persistError]);
          }
        }
        throw error;
      }
    },
    stopContainer: (unit) => {
      stopPersistedContainerUnit(runner, units, persistUnits, unit);
    },
    // [#2846] The container shell behind the portal terminal. It reads the same `units`
    // ledger the lifecycle writes, so a problem that is not actually running has no unit
    // to exec into and the attach is refused instead of hanging. [#2850] The shell may
    // only enter the service each problem's metadata opted in with (`runtime.terminal`);
    // the spawner additionally verifies the live compose config builds that service with
    // `target: participant` before any exec.
    spawnShell: createProblemShellSpawner(
      units,
      new Map(
        deployment.problems.flatMap((problem) =>
          problem.terminal ? [[problem.problemId, problem.terminal.service] as const] : [],
        ),
      ),
    ),
    simulator,
    simulatorSnapshotDir: join(p.localDir, "snapshots"),
    stateStore,
    // [#2927] Ask the daemon which host ports are really taken before claiming an offset.
    // The offset pool only knows this session's slots, so a container a previous session
    // left running is invisible to it — that is how two problems hardcoding 18080 made a
    // 45-hour-old container block a fresh start with only the daemon's raw message.
    portConflicts: createPortConflictProbe(
      (problemId) =>
        deployment.problems.find((problem) => problem.problemId === problemId)?.composePath,
    ),
    // [#2925 / #2926] The participant-facing catalog the portal renders narrative,
    // course tracks and plugin slots from. Read from the bind-mounted `problems/` at
    // serve time because the Docker image deliberately does not carry it, which left
    // the portal's build-time glob empty and those surfaces blank.
    problemCatalog: loadServedProblemCatalog(),
    // [#2906] Unset on the host/dev path — only the containerized entrypoint
    // (containerServe, below) sets this, so `up`'s detached `serve` is unaffected.
    // The container binds 127.0.0.1 the same as the host/dev default (it runs
    // with `network_mode: host` — see compose.local.yaml — so that address
    // genuinely IS the host's loopback, not a separate namespace to bridge).
    ...(process.env.TENKACLOUD_LOCAL_PORTAL_DIST
      ? { portalDistDir: process.env.TENKACLOUD_LOCAL_PORTAL_DIST }
      : {}),
  });

  // [#2512] No idle sweeper: a started container keeps running until the
  // participant stops it (portal Stop / `make local-down`) or the running cap
  // evicts the least-recently-played problem to start another one.
  console.log(`Local Participant API listening on http://127.0.0.1:${server.port}`);
  console.log(`Local progress store: ${stateStore.description}`);
  let scoringCycle: Promise<void> | undefined;
  const scoringTimer = setInterval(() => {
    if (scoringCycle) return;
    const current = Promise.all(
      [...server.state.simulatedRuntimes.keys()]
        .filter((problemId) => server.state.lifecycle.statusOf(problemId) === "running")
        .map((problemId) => scoreSimulatedProblem(problemId, server.state)),
    )
      .then(() => server.persist())
      .catch(() => {
        console.error("Simulator scoring cycle failed; retrying on the next interval.");
      });
    scoringCycle = current;
    void current.finally(() => {
      if (scoringCycle === current) scoringCycle = undefined;
    });
  }, 60_000);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(scoringTimer);
    const errors = await shutdownLocalServe({
      closeServer: server.close,
      ...(scoringCycle ? { scoringCycle } : {}),
      persistState: server.persist,
      closeTerminals: () => server.state.terminals.closeAll(),
      stopAll: () => server.state.lifecycle.stopAll(),
      closeSimulator: () => simulator.close(),
      closeStateStore: server.closeStateStore,
    });
    for (const error of errors) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(errors.length > 0 ? 1 : 0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    // Park forever: the process only leaves through the SIGINT / SIGTERM handlers above.
  });
}

async function status(): Promise<void> {
  const p = privateLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readLocalProcessState(p.statePath, p);
  if (observeProcessIdentity(state.pid) !== state.processIdentity) {
    throw new Error("Local play is not running (recorded process has exited). Run local-down.");
  }
  await waitForReachable(`${state.apiBaseUrl}/healthz`, "local Participant API", 3_000);
  // A warm session may have pre-started nothing — problems start on demand.
  const preStarted =
    state.problemIds.length > 0 ? state.problemIds.join(", ") : "on-demand, none pre-started";
  console.log(`Local play is running (${preStarted}).`);
  console.log(`Participant API: ${state.apiBaseUrl}`);
  if (existsSync(p.simulatorEnvPath)) {
    console.log(`Simulator CLI environment: source ${p.simulatorEnvPath}`);
  }
}

async function evaluate(flag: string): Promise<void> {
  const p = privateLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readLocalProcessState(p.statePath, p);
  // Submit to PROBLEM when it names a problem in the session, else the first one.
  const envProblem = process.env.PROBLEM;
  const problemId =
    envProblem && state.problemIds.includes(envProblem) ? envProblem : state.problemIds[0];
  if (!problemId) throw new Error("Local play has no problems to evaluate against.");
  const response = await fetch(`${state.apiBaseUrl}/portal/me/submit-flag`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.participantToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ problemId, flag }),
  });
  const outcome = (await response.json()) as { kind?: string };
  console.log(JSON.stringify(outcome, null, 2));
  if (!response.ok || outcome.kind === "wrong") process.exitCode = 1;
}

async function reset(problemId: string): Promise<void> {
  const p = privateLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readLocalProcessState(p.statePath, p);
  const response = await fetch(
    `${state.apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/reset`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.participantToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(`reset failed (HTTP ${response.status}): ${await response.text()}`);
  }
  console.log(`Local problem reset: ${problemId}`);
}

async function fireDisruption(problemId: string, disruptionId: string): Promise<void> {
  const p = privateLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readLocalProcessState(p.statePath, p);
  const response = await fetch(
    `${state.apiBaseUrl}/local/operator/problems/${encodeURIComponent(problemId)}/disruptions/${encodeURIComponent(disruptionId)}/fire`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.participantToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(`disruption failed (HTTP ${response.status}): ${await response.text()}`);
  }
  console.log(`Simulator disruption fired: ${problemId}/${disruptionId}`);
}

async function snapshot(
  action: "export" | "import",
  problemId: string,
  name: string,
): Promise<void> {
  const p = privateLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readLocalProcessState(p.statePath, p);
  const response = await fetch(
    `${state.apiBaseUrl}/local/operator/problems/${encodeURIComponent(problemId)}/snapshots/${encodeURIComponent(name)}/${action}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.participantToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(`Simulator snapshot ${action} failed (HTTP ${response.status})`);
  }
  const snapshotPath = join(p.localDir, "snapshots", `${name}.json`);
  console.log(`Simulator snapshot ${action}ed: ${snapshotPath}`);
}

async function down(): Promise<void> {
  const p = privateLocalPaths();
  let databaseBackend = localPlayDatabaseBackend(process.env);
  let recordedState: LocalProcessState | undefined;
  if (existsSync(p.statePath)) {
    recordedState = readLocalProcessState(p.statePath, p);
    databaseBackend = recordedState.databaseBackend ?? databaseBackend;
    stopRecordedServeProcess(recordedState);
    if (
      !(await waitForServeProcessExit(
        recordedState.pid,
        recordedState.processIdentity,
        SERVE_SHUTDOWN_TIMEOUT_MS,
      ))
    ) {
      throw new Error("Local-play serve process did not stop; refusing concurrent cleanup");
    }
    await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
  } else {
    await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
  }
  // [#2392 Phase 2] Containers are owned by the serve process's lifecycle;
  // units.json is its persisted mirror, so this also reclaims crash leftovers.
  tearDownRecordedUnits(p);
  await clearLocalPlayStateStore(p, {
    ...process.env,
    TENKACLOUD_LOCAL_DATABASE: databaseBackend,
  });
  if (recordedState) {
    releaseSessionState(p, recordedState);
  } else {
    unlinkIfExists(p.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, false);
  }
  console.log("Local play stopped and progress cleared.");
}

function describeTarget(target: { readonly provider: string; readonly engine: string }): string {
  return `${target.provider}/${target.engine}`;
}

/**
 * Issue #2188: `make local list` — show which problems are playable locally
 * (id / display name / category) so players can choose one instead of already
 * needing to know the id.
 */
/**
 * [#3008] Print the local-play rows, marking any problem whose declared
 * `runtime.compatibility` this machine cannot satisfy, and then explaining each one.
 *
 * An unsupported problem is still listed: hiding it would look identical to a problem that
 * was never authored, and the participant would have no way to learn that the reason is
 * their machine. Extracted from {@link listProblems} to keep that function's branching flat.
 */
function printLocalProblemRows(
  summaries: readonly LocalPlayProblemSummary[],
  idWidth: number,
  categoryWidth: number,
): void {
  // Evaluated once for the whole listing; the gate probes the host lazily, so a catalog
  // where nothing declares a requirement never runs `docker info` at all.
  const compatibilityOf = createNativeCompatibilityGate(
    (problemId) => summaries.find((s) => s.problemId === problemId)?.compatibility,
  );
  const refusals: string[] = [];
  for (const s of summaries) {
    const verdict = compatibilityOf(s.problemId);
    const mark = verdict.supported ? "" : "  [not startable on this machine]";
    if (!verdict.supported) {
      refusals.push(
        `  ${s.problemId}: ${verdict.message}`,
        `  ${s.problemId}: ${verdict.messageJa}`,
      );
    }
    console.log(
      `  ${s.problemId.padEnd(idWidth)}  ${s.category.padEnd(categoryWidth)}  ${s.name}${mark}`,
    );
  }
  if (refusals.length > 0) console.log(`\n${refusals.join("\n")}`);
}

function listProblems(): void {
  const roots = problemSearchRoots(REPO_ROOT);
  // [#2696 PR5] Same pin the portal catalog applies (loadLocalPlayCatalog) — the
  // CLI text listing and the Participant Portal must agree on which drill is "first".
  let summaries = pinIntroDrillFirst(listLocalPlayProblems(roots));
  if (summaries.length === 0 && autoInitProblemsSubmodule(REPO_ROOT)) {
    summaries = pinIntroDrillFirst(listLocalPlayProblems(roots));
  }
  // [#2632] Simulator problems are OFF by default (opt in: TENKACLOUD_LOCAL_SIMULATOR=1).
  const simulated = enabledSimulatedCloudSummaries(roots);
  if (summaries.length === 0 && simulated.length === 0) {
    console.log(
      "No local-play problems found. Run `git submodule update --init` (or `tenkacloud doctor` / " +
        "`make local-onboard`) to fetch the problems/ catalog.",
    );
    return;
  }
  console.log("Local-play problems (`tenkacloud local --problem <id>`):\n");
  const idWidth = Math.max(...summaries.map((s) => s.problemId.length), "id".length);
  const categoryWidth = Math.max(...summaries.map((s) => s.category.length), "category".length);
  console.log(`  ${"id".padEnd(idWidth)}  ${"category".padEnd(categoryWidth)}  name`);
  printLocalProblemRows(summaries, idWidth, categoryWidth);
  if (simulated.length > 0) {
    console.log("\nSimulated-cloud problems (use the pinned Simulator image by default):\n");
    const simIdWidth = Math.max(...simulated.map((s) => s.problemId.length), "id".length);
    const simCategoryWidth = Math.max(
      ...simulated.map((s) => s.category.length),
      "category".length,
    );
    console.log(
      `  ${"id".padEnd(simIdWidth)}  ${"category".padEnd(simCategoryWidth)}  runtime  name`,
    );
    for (const s of simulated) {
      const runtime =
        "kind" in s.runtime
          ? `composite(${s.runtime.targets.map(describeTarget).join("+")})`
          : `${s.runtime.provider}/${s.runtime.engine}`;
      console.log(
        `  ${s.problemId.padEnd(simIdWidth)}  ${s.category.padEnd(simCategoryWidth)}  ${runtime.padEnd(24)}  ${s.name}`,
      );
    }
  }
}

function usage(): string {
  return [
    "Usage: bun run scripts/tenkacloud-local.ts <command>",
    "",
    "Commands:",
    "  list             List local-play problems (id / category / name)",
    "  up [problemIds]  Start the detached local API; PROBLEM=a,b,c pre-starts those containers",
    "  serve <path>     Run the local Participant API (used internally by up)",
    "  container-serve  Run the local Participant API in the foreground (the container entrypoint)",
    "  status           Check the local Participant API",
    "  evaluate <flag>  Submit a flag through the local scoring API",
    "  reset <problem>  Delete and recreate one local runtime",
    "  snapshot-export <problem>  Export SNAPSHOT=<name> from a Simulator world",
    "  snapshot-import <problem>  Import SNAPSHOT=<name> into a Simulator world",
    "  disrupt <problem>  Fire DISRUPTION=<id> through the Simulator provider command",
    "  down             Stop local services and clear all persisted progress",
    "",
    "Simulated-cloud (multicloud Simulator) problems are experimental and hidden by",
    "default; opt in with TENKACLOUD_LOCAL_SIMULATOR=1 on the developer path",
    "(e.g. TENKACLOUD_LOCAL_SIMULATOR=1 make local-dev). The Docker participant path",
    "(make local) does not forward this variable into the container — see ADR-055.",
  ].join("\n");
}

async function handleSimulatorCommand(
  command: string | undefined,
  argument: string | undefined,
): Promise<boolean> {
  if (command === "reset") {
    if (!argument) throw new Error("reset requires a problem id");
    await reset(argument);
    return true;
  }
  if (command === "snapshot-export" || command === "snapshot-import") {
    if (!argument) throw new Error(`${command} requires a problem id`);
    await snapshot(
      command === "snapshot-export" ? "export" : "import",
      argument,
      process.env.SNAPSHOT ?? "latest",
    );
    return true;
  }
  if (command === "disrupt") {
    if (!argument) throw new Error("disrupt requires a problem id");
    if (!process.env.DISRUPTION) throw new Error("DISRUPTION is required");
    await fireDisruption(argument, process.env.DISRUPTION);
    return true;
  }
  return false;
}

export async function runLocalPlayCommand(args: readonly string[]): Promise<void> {
  const [command, argument] = args;
  if (await handleSimulatorCommand(command, argument)) return;
  switch (command) {
    case "list":
      listProblems();
      break;
    case "up":
      // [#2392 Phase 2] No PROBLEM = a warm session with zero containers;
      // problems start on demand from the portal / API.
      await up(argument ?? process.env.PROBLEM ?? "");
      break;
    case "serve":
      if (!argument) throw new Error("serve requires a deployment state path");
      await serve(argument);
      break;
    case "container-serve":
      await containerServe();
      break;
    case "status":
      await status();
      break;
    case "evaluate":
      if (!argument) throw new Error("evaluate requires a flag");
      await evaluate(argument);
      break;
    case "down":
      await down();
      break;
    default:
      console.log(usage());
      if (command !== undefined) process.exitCode = 1;
  }
}

if (import.meta.main) {
  void runLocalPlayCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
