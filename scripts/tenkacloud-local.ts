import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreSimulatedProblem } from "./local-play/api-scoring";
import type { LocalPlayDeployment } from "./local-play/api-state";
import {
  autoInitProblemsSubmodule,
  loadLocalPlayCatalog,
  problemSearchRoots,
} from "./local-play/catalog-loader";
import { browserDisplayText, buildLocalRuntimeConfig } from "./local-play/codespaces-links";
import {
  type ContainerRunner,
  ContainerStartOwnershipError,
  type LocalComposeUnit,
} from "./local-play/container-runner";
import { parseProblemIds } from "./local-play/deployment-plan";
import {
  createContainerRunner,
  resolveComposeCli,
  startDetachedServe,
  waitForReachable,
} from "./local-play/docker-adapter";
import { listLocalPlayProblems } from "./local-play/manifest";
import { observeProcessIdentity } from "./local-play/process-identity";
import { assertPortFree, freeLoopbackPort, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import {
  type LocalPaths,
  type LocalProcessState,
  type RecordedUnits,
  readLocalProcessState,
  readPrivateJson,
  readRecordedUnits,
  reclaimStaleSession,
  releaseSessionState,
  resolveLocalPaths,
  restoreRuntimeConfig,
  stopRecordedProcess,
  stopRecordedServeProcess,
  unlinkIfExists,
  writePrivateJson,
} from "./local-play/session-state";
import { listSimulatedCloudProblems, loadSimulatedCloudProblems } from "./local-play/simulator";
import {
  cleanupRecordedSimulatorSession,
  SimulatorLocalRuntime,
} from "./local-play/simulator-runtime";

/**
 * [#2527 Slice 6] The local-play CLI entrypoint: command routing + composition only.
 * The four concern layers live in `scripts/local-play/` — `docker-adapter.ts`
 * (process/container adapter), `session-state.ts` (on-disk session state),
 * `codespaces-links.ts` (browser URL presentation), `catalog-loader.ts` (catalog) —
 * and the commands below orchestrate them.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_SHUTDOWN_TIMEOUT_MS = 45_000;

export interface LocalServeShutdownDeps {
  readonly closeServer: () => Promise<void>;
  readonly scoringCycle?: Promise<void>;
  readonly stopAll: () => Promise<void>;
  readonly closeSimulator: () => Promise<void>;
}

/** Quiesce ingress and scoring before either lifecycle owner mutates persisted state. */
export async function shutdownLocalServe(deps: LocalServeShutdownDeps): Promise<unknown[]> {
  const errors: unknown[] = [];
  const serverClosed = deps.closeServer().catch((error: unknown) => {
    errors.push(error);
  });
  const scoringSettled = (deps.scoringCycle ?? Promise.resolve()).catch((error: unknown) => {
    errors.push(error);
  });
  await Promise.all([serverClosed, scoringSettled]);
  try {
    await deps.stopAll();
  } catch (error) {
    errors.push(error);
  }
  try {
    await deps.closeSimulator();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

/** Release a Docker unit only after its durable ownership projection commits. */
export function stopPersistedContainerUnit(
  runner: Pick<ContainerRunner, "stopPhysical" | "finalizeStop">,
  units: Map<string, LocalComposeUnit>,
  persistUnits: () => void,
  unit: LocalComposeUnit,
): void {
  runner.stopPhysical(unit);
  units.delete(unit.problemId);
  try {
    persistUnits();
  } catch (error) {
    // The temp compose remains available, so portal Stop can safely retry the
    // idempotent compose down and the durable units projection.
    units.set(unit.problemId, unit);
    throw error;
  }
  try {
    runner.finalizeStop(unit);
  } catch (finalizeError) {
    units.set(unit.problemId, unit);
    try {
      persistUnits();
    } catch (recoveryError) {
      throw new AggregateError(
        [finalizeError, recoveryError],
        "Container stopped but its cleanup ownership could not be restored",
      );
    }
    throw finalizeError;
  }
}

/** Persist a newly-owned unit; on an ambiguous commit keep its compose handle for cleanup retry. */
export function persistStartedContainerUnit(
  units: Map<string, LocalComposeUnit>,
  persistUnits: () => void,
  unit: LocalComposeUnit,
): void {
  units.set(unit.problemId, unit);
  try {
    persistUnits();
  } catch (persistError) {
    try {
      // A write can throw after rename/directory fsync. Re-commit the full
      // ownership projection before returning so crash cleanup has the unit.
      persistUnits();
    } catch (recoveryError) {
      throw new ContainerStartOwnershipError(unit, [persistError, recoveryError]);
    }
    throw new ContainerStartOwnershipError(unit, [persistError]);
  }
}

export async function waitForServeProcessExit(
  pid: number,
  expectedIdentity: string | undefined,
  timeoutMs: number,
  observe: (processId: number) => string | undefined = observeProcessIdentity,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentIdentity = observe(pid);
    if (currentIdentity === undefined) return true;
    // The recorded process exited and the OS reused its numeric PID. Treat the
    // original as gone; never wait on or signal its replacement.
    if (expectedIdentity !== undefined && currentIdentity !== expectedIdentity) return true;
    await delay(50);
  }
  const currentIdentity = observe(pid);
  return (
    currentIdentity === undefined ||
    (expectedIdentity !== undefined && currentIdentity !== expectedIdentity)
  );
}

function positivePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function requiredLocalApiPort(value: string | undefined): number {
  if (!value) {
    throw new Error("LOCAL_API_PORT is required for the detached local-play serve process");
  }
  return positivePort(value, 1, "LOCAL_API_PORT");
}

export function ensurePrivateLocalDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateLocalPaths(): LocalPaths {
  const paths = resolveLocalPaths();
  ensurePrivateLocalDirectory(paths.localDir);
  return paths;
}

function assertDockerAvailable(): void {
  resolveComposeCli();
}

/**
 * Tear down every container recorded in `units.json` (idempotent compose down)
 * and drop the file. Used by `down`, by `up`'s failure cleanup, and by `up` to
 * reclaim leftovers from a crashed previous session before starting a new one.
 */
function tearDownRecordedUnits(p: LocalPaths): void {
  if (!existsSync(p.unitsPath)) return;
  const runner = createContainerRunner(p.localDir);
  const recorded = readRecordedUnits(p.unitsPath, p.localDir).units;
  const units = new Map(recorded.map((unit) => [unit.problemId, unit]));
  const persistRemaining = (): void => {
    if (units.size > 0) {
      writePrivateJson(p.unitsPath, { units: [...units.values()] } satisfies RecordedUnits);
    } else {
      unlinkIfExists(p.unitsPath);
    }
  };
  const errors: unknown[] = [];
  for (const unit of recorded) {
    try {
      stopPersistedContainerUnit(runner, units, persistRemaining, unit);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Recorded container cleanup failed and can be retried");
  }
}

/** Pre-start one problem through the serve process's API (its lifecycle owns the container). */
async function startProblemViaApi(
  apiBaseUrl: string,
  problemId: string,
  participantToken: string,
): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/start`,
    { method: "POST", headers: { authorization: `Bearer ${participantToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `failed to start problem "${problemId}" (HTTP ${response.status}): ${await response.text()}`,
    );
  }
}

/** Print the running problems' challenge endpoints as the API sees them (post-remap). */
function endpointDisplay(label: string, value: string): string {
  if (/credential|accesskey/i.test(label)) return "[available in Participant Portal]";
  if (!URL.canParse(value)) return value;
  const parsed = new URL(value);
  if (parsed.hash) parsed.hash = "";
  return parsed.toString();
}

async function printRunningEndpoints(apiBaseUrl: string, participantToken: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/portal/me`, {
    headers: { authorization: `Bearer ${participantToken}` },
  });
  const body = (await response.json()) as {
    problems?: Array<{
      name: string;
      stackOutputs: Record<string, string>;
      lifecycle?: { status?: string };
    }>;
  };
  for (const problem of body.problems ?? []) {
    if (problem.lifecycle?.status !== "running") continue;
    for (const [label, url] of Object.entries(problem.stackOutputs)) {
      console.log(`Challenge — ${problem.name} (${label}): ${endpointDisplay(label, url)}`);
    }
  }
}

/** Any HTTP answer from /healthz means the recorded API process is alive. */
async function apiIsHealthy(apiBaseUrl: string): Promise<boolean> {
  try {
    await fetch(`${apiBaseUrl}/healthz`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

export async function recordedApiIsHealthy(
  state: LocalProcessState,
  observe: (pid: number) => string | undefined = observeProcessIdentity,
  probe: (apiBaseUrl: string) => Promise<boolean> = apiIsHealthy,
): Promise<boolean> {
  if (observe(state.pid) !== state.processIdentity) return false;
  return probe(state.apiBaseUrl);
}

async function up(problemArg: string): Promise<void> {
  const p = privateLocalPaths();
  await reclaimStaleSession(
    p.statePath,
    () => readLocalProcessState(p.statePath, p),
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
      await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
      releaseSessionState(p, state);
    },
  );

  const problemIds = parseProblemIds(problemArg);
  const apiPort = process.env.LOCAL_API_PORT
    ? positivePort(process.env.LOCAL_API_PORT, 1, "LOCAL_API_PORT")
    : await freeLoopbackPort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  if (process.env.LOCAL_API_PORT) await assertPortFree(apiPort, "Participant API");
  // Leftover containers from a crashed session would collide with this one on
  // the same port blocks — reclaim them first (idempotent).
  tearDownRecordedUnits(p);

  // [#2392 Phase 2] Warm session: the API serves the WHOLE local-play catalog
  // and containers start on demand. PROBLEM= only selects what to pre-start —
  // none means a warm session with zero containers.
  const roots = problemSearchRoots(REPO_ROOT);
  const catalog = loadLocalPlayCatalog(REPO_ROOT, roots);
  const simulatedCatalog = loadSimulatedCloudProblems(roots);
  const catalogIds = new Set([...catalog, ...simulatedCatalog].map((problem) => problem.problemId));
  for (const id of problemIds) {
    if (!catalogIds.has(id)) {
      throw new Error(`problem "${id}" was not found under: ${roots.join(", ")}`);
    }
  }
  const containerIds = new Set(catalog.map((problem) => problem.problemId));
  if (problemIds.length === 0 || problemIds.some((id) => containerIds.has(id))) {
    assertDockerAvailable();
  }

  let runtimeConfigBackedUp = false;
  if (existsSync(p.runtimeConfigBackupPath)) {
    // An orphaned backup from a crashed run holds the real original — adopt it
    // rather than overwriting it with the (possibly stale local) live config.
    runtimeConfigBackedUp = true;
  } else if (existsSync(p.runtimeConfigPath)) {
    copyFileSync(p.runtimeConfigPath, p.runtimeConfigBackupPath);
    runtimeConfigBackedUp = true;
  }

  let apiPid: number | undefined;
  let apiProcessIdentity: string | undefined;
  try {
    const participantToken = randomBytes(32).toString("base64url");
    const deployment: LocalPlayDeployment = {
      problems: catalog,
      simulatedProblems: simulatedCatalog,
      participantToken,
    };
    writePrivateJson(p.deploymentPath, deployment);
    apiPid = startDetachedServe(p.deploymentPath, apiPort, p.logPath);
    apiProcessIdentity = observeProcessIdentity(apiPid);
    if (!apiProcessIdentity) {
      throw new Error("Local Participant API process identity could not be recorded");
    }
    const state: LocalProcessState = {
      pid: apiPid,
      processIdentity: apiProcessIdentity,
      apiBaseUrl,
      problemIds,
      deploymentPath: p.deploymentPath,
      runtimeConfigPath: p.runtimeConfigPath,
      participantToken,
      ...(runtimeConfigBackedUp ? { runtimeConfigBackupPath: p.runtimeConfigBackupPath } : {}),
    };
    // Commit ownership before any pre-start or runtime-config side effect. A
    // parent crash from this point is recoverable by the next up/down command.
    writePrivateJson(p.statePath, state);
    await waitForLocalApi(apiBaseUrl, problemIds, apiPid, p.logPath);

    // Pre-start the requested problems through the API so the serve process's
    // lifecycle owns every container (cap + LRU eviction included).
    for (const id of problemIds) {
      await startProblemViaApi(apiBaseUrl, id, participantToken);
    }

    const runtimeConfig = buildLocalRuntimeConfig(apiBaseUrl, participantToken);
    writeFileSync(p.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");

    console.log(
      `Local play is ready (catalog: ${catalog.length + simulatedCatalog.length} problem${catalog.length + simulatedCatalog.length > 1 ? "s" : ""}, ` +
        `${problemIds.length} pre-started).`,
    );
    console.log(`Participant API: ${apiBaseUrl}`);
    await printRunningEndpoints(apiBaseUrl, participantToken);
    if (problemIds.length === 0) {
      console.log(
        "No problem was pre-started; run `make local PROBLEM=<id>` or start one from the portal.",
      );
    }
    console.log(
      "Started containers keep running until you stop them: use the portal Stop button " +
        "for one problem, or `make local-down` to stop everything.",
    );
    console.log(
      "Participant Portal opens from `make local`; if you used `make local-up`, run `make local-portal`.",
    );
  } catch (error) {
    const errors: unknown[] = [error];
    let serveExited = apiPid === undefined;
    if (apiPid !== undefined) {
      try {
        apiProcessIdentity ??= observeProcessIdentity(apiPid);
        stopRecordedProcess(apiPid, apiProcessIdentity, "Local-play serve");
        serveExited = await waitForServeProcessExit(
          apiPid,
          apiProcessIdentity,
          SERVE_SHUTDOWN_TIMEOUT_MS,
        );
        if (!serveExited) {
          throw new Error("Local-play serve process did not stop; refusing concurrent cleanup");
        }
      } catch (shutdownError) {
        errors.push(shutdownError);
      }
    }
    if (serveExited) {
      try {
        await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      unlinkIfExists(p.deploymentPath);
      unlinkIfExists(p.statePath);
      restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
      tearDownRecordedUnits(p);
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Local play startup failed and cleanup was incomplete");
    }
    throw error;
  }
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
  ].sort();

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
    simulator,
    simulatorSnapshotDir: join(p.localDir, "snapshots"),
  });

  // [#2512] No idle sweeper: a started container keeps running until the
  // participant stops it (portal Stop / `make local-down`) or the running cap
  // evicts the least-recently-played problem to start another one.
  console.log(`Local Participant API listening on http://127.0.0.1:${server.port}`);
  let scoringCycle: Promise<void> | undefined;
  const scoringTimer = setInterval(() => {
    if (scoringCycle) return;
    const current = Promise.all(
      [...server.state.simulatedRuntimes.keys()]
        .filter((problemId) => server.state.lifecycle.statusOf(problemId) === "running")
        .map((problemId) => scoreSimulatedProblem(problemId, server.state)),
    )
      .then(() => {})
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
      stopAll: () => server.state.lifecycle.stopAll(),
      closeSimulator: () => simulator.close(),
    });
    for (const error of errors) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(errors.length > 0 ? 1 : 0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
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
  console.log(`Simulator snapshot ${action}ed: ${join(p.localDir, "snapshots", `${name}.json`)}`);
}

async function down(): Promise<void> {
  const p = privateLocalPaths();
  if (existsSync(p.statePath)) {
    const state = readLocalProcessState(p.statePath, p);
    stopRecordedServeProcess(state);
    if (
      !(await waitForServeProcessExit(state.pid, state.processIdentity, SERVE_SHUTDOWN_TIMEOUT_MS))
    ) {
      throw new Error("Local-play serve process did not stop; refusing concurrent cleanup");
    }
    await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
    releaseSessionState(p, state);
  } else {
    await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
    unlinkIfExists(p.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, false);
  }
  // [#2392 Phase 2] Containers are owned by the serve process's lifecycle;
  // units.json is its persisted mirror, so this also reclaims crash leftovers.
  tearDownRecordedUnits(p);
  console.log("Local play stopped.");
}

/**
 * Issue #2188: `make local list` — show which problems are playable locally
 * (id / display name / category) so players can choose one instead of already
 * needing to know the id.
 */
function listProblems(): void {
  const roots = problemSearchRoots(REPO_ROOT);
  let summaries = listLocalPlayProblems(roots);
  if (summaries.length === 0 && autoInitProblemsSubmodule(REPO_ROOT)) {
    summaries = listLocalPlayProblems(roots);
  }
  const simulated = listSimulatedCloudProblems(roots);
  if (summaries.length === 0 && simulated.length === 0) {
    console.log(
      "No local-play problems found. Run `git submodule update --init` (or `make doctor` / " +
        "`make local-onboard`) to fetch the problems/ catalog.",
    );
    return;
  }
  console.log("Local-play problems (`make local PROBLEM=<id>`):\n");
  const idWidth = Math.max(...summaries.map((s) => s.problemId.length), "id".length);
  const categoryWidth = Math.max(...summaries.map((s) => s.category.length), "category".length);
  console.log(`  ${"id".padEnd(idWidth)}  ${"category".padEnd(categoryWidth)}  name`);
  for (const s of summaries) {
    console.log(`  ${s.problemId.padEnd(idWidth)}  ${s.category.padEnd(categoryWidth)}  ${s.name}`);
  }
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
          ? `composite(${s.runtime.targets.map((target) => `${target.provider}/${target.engine}`).join("+")})`
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
    "  status           Check the local Participant API",
    "  evaluate <flag>  Submit a flag through the local scoring API",
    "  reset <problem>  Delete and recreate one local runtime",
    "  snapshot-export <problem>  Export SNAPSHOT=<name> from a Simulator world",
    "  snapshot-import <problem>  Import SNAPSHOT=<name> into a Simulator world",
    "  disrupt <problem>  Fire DISRUPTION=<id> through the Simulator provider command",
    "  down             Stop local services and remove local state",
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

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
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
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
