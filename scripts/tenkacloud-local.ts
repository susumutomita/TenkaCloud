import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import type { LocalComposeUnit } from "./local-play/container-runner";
import { parseProblemIds } from "./local-play/deployment-plan";
import {
  createContainerRunner,
  resolveComposeCli,
  startDetachedServe,
  waitForReachable,
} from "./local-play/docker-adapter";
import { listLocalPlayProblems } from "./local-play/manifest";
import { assertPortFree, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import {
  type LocalPaths,
  type LocalProcessState,
  type RecordedUnits,
  readJson,
  reclaimStaleSession,
  releaseSessionState,
  resolveLocalPaths,
  restoreRuntimeConfig,
  stopPid,
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
const DEFAULT_API_PORT = 3199;

function positivePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
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
  for (const unit of readJson<RecordedUnits>(p.unitsPath).units) runner.stop(unit);
  unlinkIfExists(p.unitsPath);
}

/** Pre-start one problem through the serve process's API (its lifecycle owns the container). */
async function startProblemViaApi(apiBaseUrl: string, problemId: string): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/start`,
    { method: "POST", headers: { authorization: "Bearer local" } },
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

async function printRunningEndpoints(apiBaseUrl: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/portal/me`, {
    headers: { authorization: "Bearer local" },
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

async function up(problemArg: string): Promise<void> {
  const p = resolveLocalPaths();
  await reclaimStaleSession(
    p.statePath,
    () => readJson<LocalProcessState>(p.statePath),
    apiIsHealthy,
    async (state) => {
      await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
      releaseSessionState(p, state);
    },
  );

  const problemIds = parseProblemIds(problemArg);
  const apiPort = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  await assertPortFree(apiPort, "Participant API");
  mkdirSync(p.localDir, { recursive: true });
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
  try {
    const deployment: LocalPlayDeployment = {
      problems: catalog,
      simulatedProblems: simulatedCatalog,
    };
    writePrivateJson(p.deploymentPath, deployment);
    apiPid = startDetachedServe(p.deploymentPath, apiPort, p.logPath);
    await waitForLocalApi(apiBaseUrl, problemIds, apiPid, p.logPath);

    // Pre-start the requested problems through the API so the serve process's
    // lifecycle owns every container (cap + LRU eviction included).
    for (const id of problemIds) {
      await startProblemViaApi(apiBaseUrl, id);
    }

    const runtimeConfig = buildLocalRuntimeConfig(apiBaseUrl);
    writeFileSync(p.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");

    const state: LocalProcessState = {
      pid: apiPid,
      apiBaseUrl,
      problemIds,
      deploymentPath: p.deploymentPath,
      runtimeConfigPath: p.runtimeConfigPath,
      ...(runtimeConfigBackedUp ? { runtimeConfigBackupPath: p.runtimeConfigBackupPath } : {}),
    };
    writePrivateJson(p.statePath, state);

    console.log(
      `Local play is ready (catalog: ${catalog.length + simulatedCatalog.length} problem${catalog.length + simulatedCatalog.length > 1 ? "s" : ""}, ` +
        `${problemIds.length} pre-started).`,
    );
    console.log(`Participant API: ${apiBaseUrl}`);
    await printRunningEndpoints(apiBaseUrl);
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
    if (apiPid !== undefined) stopPid(apiPid);
    unlinkIfExists(p.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
    tearDownRecordedUnits(p);
    throw error;
  }
}

async function serve(deploymentPath: string): Promise<void> {
  if (!existsSync(deploymentPath)) {
    throw new Error(`Local deployment state was not found: ${deploymentPath}`);
  }
  const p = resolveLocalPaths();
  const deployment = readJson<LocalPlayDeployment>(deploymentPath);
  const port = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");
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
      const started = await runner.start(problem, offset);
      units.set(started.unit.problemId, started.unit);
      persistUnits();
      return started;
    },
    stopContainer: (unit) => {
      runner.stop(unit);
      units.delete(unit.problemId);
      persistUnits();
    },
    simulator,
  });

  // [#2512] No idle sweeper: a started container keeps running until the
  // participant stops it (portal Stop / `make local-down`) or the running cap
  // evicts the least-recently-played problem to start another one.
  console.log(`Local Participant API listening on http://127.0.0.1:${server.port}`);
  let scoring = false;
  const scoringTimer = setInterval(() => {
    if (scoring) return;
    scoring = true;
    void Promise.all(
      [...server.state.simulatedRuntimes.keys()]
        .filter((problemId) => server.state.lifecycle.statusOf(problemId) === "running")
        .map((problemId) => scoreSimulatedProblem(problemId, server.state)),
    )
      .catch((error) => {
        console.error(
          `Simulator scoring cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        scoring = false;
      });
  }, 60_000);
  const shutdown = async () => {
    clearInterval(scoringTimer);
    let exitCode = 0;
    try {
      await server.state.lifecycle.stopAll();
      await simulator.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
    await server.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

async function status(): Promise<void> {
  const p = resolveLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
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
  const p = resolveLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
  // Submit to PROBLEM when it names a problem in the session, else the first one.
  const envProblem = process.env.PROBLEM;
  const problemId =
    envProblem && state.problemIds.includes(envProblem) ? envProblem : state.problemIds[0];
  if (!problemId) throw new Error("Local play has no problems to evaluate against.");
  const response = await fetch(`${state.apiBaseUrl}/portal/me/submit-flag`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({ problemId, flag }),
  });
  const outcome = (await response.json()) as { kind?: string };
  console.log(JSON.stringify(outcome, null, 2));
  if (!response.ok || outcome.kind === "wrong") process.exitCode = 1;
}

async function reset(problemId: string): Promise<void> {
  const p = resolveLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
  const response = await fetch(
    `${state.apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/reset`,
    { method: "POST", headers: { authorization: "Bearer local" } },
  );
  if (!response.ok) {
    throw new Error(`reset failed (HTTP ${response.status}): ${await response.text()}`);
  }
  console.log(`Local problem reset: ${problemId}`);
}

async function fireDisruption(problemId: string, disruptionId: string): Promise<void> {
  const p = resolveLocalPaths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
  const response = await fetch(
    `${state.apiBaseUrl}/local/operator/problems/${encodeURIComponent(problemId)}/disruptions/${encodeURIComponent(disruptionId)}/fire`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`disruption failed (HTTP ${response.status}): ${await response.text()}`);
  }
  console.log(`Simulator disruption fired: ${problemId}/${disruptionId}`);
}

function snapshotName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error("SNAPSHOT must contain only letters, digits, dot, underscore, and hyphen");
  }
  return value;
}

async function snapshot(
  action: "export" | "import",
  problemId: string,
  name: string,
): Promise<void> {
  const p = resolveLocalPaths();
  if (!existsSync(p.simulatorSessionPath)) {
    throw new Error("No running Simulator session was found.");
  }
  const snapshotsDir = join(p.localDir, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const path = join(snapshotsDir, `${snapshotName(name)}.json`);
  const simulator = new SimulatorLocalRuntime({
    sessionPath: p.simulatorSessionPath,
    stateDir: p.simulatorStateDir,
    logPath: p.simulatorLogPath,
    participantEnvPath: p.simulatorEnvPath,
  });
  if (action === "export") await simulator.exportSnapshot(problemId, path);
  else await simulator.importSnapshot(problemId, path);
  console.log(`Simulator snapshot ${action}ed: ${path}`);
}

async function waitForSimulatorCleanup(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function down(): Promise<void> {
  const p = resolveLocalPaths();
  if (existsSync(p.statePath)) {
    const state = readJson<LocalProcessState>(p.statePath);
    stopPid(state.pid);
    await waitForSimulatorCleanup(p.simulatorSessionPath, 5_000);
    if (existsSync(p.simulatorSessionPath)) {
      await cleanupRecordedSimulatorSession(p.simulatorSessionPath);
    }
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
    console.log("\nSimulated-cloud problems (require TENKACLOUD_SIMULATOR_URL):\n");
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
