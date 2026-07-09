import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalPlayDeployment } from "./local-play/api";
import { ContainerRunner, type LocalComposeUnit } from "./local-play/container-runner";
import { parseProblemIds } from "./local-play/deployment-plan";
import {
  listLocalPlayProblems,
  loadContainerProblem,
  resolveProblemDir,
} from "./local-play/manifest";
import { assertPortFree, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import { buildRuntimeConfig } from "./participant-portal-runtime-config";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API_PORT = 3199;
const PARTICIPANT_PORTAL_DEV_PORT = 5175;
const LOCAL_API_PROXY_PATH = "/__tenkacloud-local-api";
const LOCAL_CHALLENGE_PROXY_PATH = "/__tenkacloud-local-port";
const LOOPBACK_BROWSER_URL_RE =
  /\bhttp:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=\/|[?#]|[\s`"'<>)]|$)/g;
/** [#2392 Phase 2] How often the serve process sweeps for idle containers. */
const REAP_INTERVAL_MS = 60_000;

export type ComposeCli = Readonly<{
  command: "docker" | "docker-compose";
  prefix: readonly string[];
  label: string;
}>;

const DOCKER_COMPOSE_PLUGIN: ComposeCli = {
  command: "docker",
  prefix: ["compose"],
  label: "docker compose",
};
const DOCKER_COMPOSE_STANDALONE: ComposeCli = {
  command: "docker-compose",
  prefix: [],
  label: "docker-compose",
};

type CodespacesEnv = Readonly<{
  CODESPACE_NAME?: string;
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
}>;

interface LocalProcessState {
  readonly pid: number;
  readonly apiBaseUrl: string;
  /** The pre-started problems (`PROBLEM=a,b,c`); the API serves the whole catalog. */
  readonly problemIds: readonly string[];
  readonly deploymentPath: string;
  readonly runtimeConfigPath: string;
  readonly runtimeConfigBackupPath?: string;
}

/**
 * [#2392 Phase 2] `units.json` — the serve process's persisted mirror of its
 * running compose units. Containers are started INSIDE the detached serve
 * process, so `down` (a separate process) reads this file to know what to tear
 * down — even after a crash.
 */
interface RecordedUnits {
  readonly units: readonly LocalComposeUnit[];
}

/**
 * The catalog groups, searched in order. Problems live only in the
 * TenkaCloudChallenge catalog (the `problems/` submodule) — never in the
 * platform repo (ADR-008 / ADR-012).
 */
export function problemSearchRoots(repoRoot: string): string[] {
  return [join(repoRoot, "problems", "challenges"), join(repoRoot, "problems", "battles")];
}

/** A 256-bit hex secret. One per declared `secretEnv` name, generated per deploy. */
export function generateSecretEnv(
  names: readonly string[],
  randomHex: () => string = () => randomBytes(32).toString("hex"),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) env[name] = randomHex();
  return env;
}

export function composeArgs(
  composePath: string,
  projectName: string,
  action: "up" | "down",
  projectDirectory?: string,
): string[] {
  const base = ["compose", "-f", composePath, "-p", projectName];
  // [#2392] When a problem runs from a port-remapped copy in .tenkacloud/local,
  // pin --project-directory to the original problem dir so relative build
  // contexts and volume mounts still resolve. Omitted (identity) for the first
  // problem, which runs from its own compose file.
  if (projectDirectory) base.push("--project-directory", projectDirectory);
  return action === "up"
    ? [...base, "up", "-d"]
    : [...base, "down", "--volumes", "--remove-orphans"];
}

export function composeArgsForCli(
  cli: ComposeCli,
  composePath: string,
  projectName: string,
  action: "up" | "down",
  projectDirectory?: string,
): string[] {
  const args = composeArgs(composePath, projectName, action, projectDirectory);
  return cli.command === "docker-compose" ? args.slice(1) : args;
}

type CommandSucceeds = (command: string, args: readonly string[]) => boolean;

function commandSucceeds(command: string, args: readonly string[]): boolean {
  return spawnSync(command, [...args], { stdio: "ignore" }).status === 0;
}

function composeCliAvailable(cli: ComposeCli, succeeds: CommandSucceeds): boolean {
  return succeeds(cli.command, [...cli.prefix, "version"]);
}

function requestedComposeCli(value: string | undefined): ComposeCli | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (normalized === "docker compose") return DOCKER_COMPOSE_PLUGIN;
  if (normalized === "docker-compose") return DOCKER_COMPOSE_STANDALONE;
  throw new Error("TENKACLOUD_COMPOSE_CLI must be either `docker compose` or `docker-compose`.");
}

export function resolveComposeCli(
  env: Pick<NodeJS.ProcessEnv, "TENKACLOUD_COMPOSE_CLI"> = process.env,
  succeeds: CommandSucceeds = commandSucceeds,
): ComposeCli {
  const requested = requestedComposeCli(env.TENKACLOUD_COMPOSE_CLI);
  if (requested) {
    if (composeCliAvailable(requested, succeeds)) return requested;
    throw new Error(
      `${requested.label} was requested by TENKACLOUD_COMPOSE_CLI, but it is not available.`,
    );
  }
  if (composeCliAvailable(DOCKER_COMPOSE_PLUGIN, succeeds)) {
    return DOCKER_COMPOSE_PLUGIN;
  }
  if (composeCliAvailable(DOCKER_COMPOSE_STANDALONE, succeeds)) {
    return DOCKER_COMPOSE_STANDALONE;
  }
  throw new Error(
    "Docker Compose is required for local play. Install Docker Desktop / Engine with " +
      "`docker compose`, or install the standalone `docker-compose` command.",
  );
}

function codespacesForwardedUrl(
  port: number,
  env: CodespacesEnv = process.env,
): string | undefined {
  const name = env.CODESPACE_NAME?.trim();
  const rawDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (!name || !rawDomain) return undefined;
  const domain = rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\./, "")
    .replace(/\.$/, "");
  if (!domain) return undefined;
  return `https://${name}-${port}.${domain}`;
}

function browserApiBaseUrl(apiBaseUrl: string, env: CodespacesEnv = process.env): string {
  const codespacesPortalUrl = codespacesForwardedUrl(PARTICIPANT_PORTAL_DEV_PORT, env);
  if (codespacesPortalUrl) return `${codespacesPortalUrl}${LOCAL_API_PROXY_PATH}`;
  try {
    const url = new URL(apiBaseUrl);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) {
      return codespacesForwardedUrl(port, env) ?? apiBaseUrl;
    }
  } catch {
    // buildRuntimeConfig validates the URL and reports the real error below.
  }
  return apiBaseUrl;
}

export function browserDisplayText(text: string, env: CodespacesEnv = process.env): string {
  return text.replace(LOOPBACK_BROWSER_URL_RE, (match, port: string) => {
    const portalUrl = codespacesForwardedUrl(PARTICIPANT_PORTAL_DEV_PORT, env);
    if (!portalUrl) return match;
    return `${portalUrl}${LOCAL_CHALLENGE_PROXY_PATH}/${port}`;
  });
}

export function buildLocalRuntimeConfig(apiBaseUrl: string, env: CodespacesEnv = process.env) {
  // `out`/`print` are unused by buildRuntimeConfig (it returns the object; up()
  // writes the file itself) — pass inert values to satisfy the option type.
  return buildRuntimeConfig({
    cloudMode: "local",
    portalMode: "backend",
    apiBaseUrl: browserApiBaseUrl(apiBaseUrl, env),
    eventTitle: "TenkaCloud Local",
    eventRegion: "local",
    out: "",
    print: false,
  });
}

function paths() {
  const localDir = process.env.TENKACLOUD_LOCAL_DIR ?? join(REPO_ROOT, ".tenkacloud", "local");
  return {
    localDir,
    statePath: join(localDir, "state.json"),
    deploymentPath: join(localDir, "deployment.json"),
    unitsPath: join(localDir, "units.json"),
    runtimeConfigBackupPath: join(localDir, "runtime-config.backup.json"),
    logPath: join(localDir, "api.log"),
    runtimeConfigPath: join(
      REPO_ROOT,
      "apps",
      "participant-portal",
      "public",
      "runtime-config.json",
    ),
  };
}

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

function runCompose(
  composePath: string,
  projectName: string,
  action: "up" | "down",
  env: NodeJS.ProcessEnv,
  allowFailure = false,
  projectDirectory?: string,
): void {
  const cli = resolveComposeCli();
  const args = composeArgsForCli(cli, composePath, projectName, action, projectDirectory);
  const result = spawnSync(cli.command, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${cli.command} ${args.join(" ")} failed`);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
}

async function waitForReachable(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer (even 401/404/405) means the container is listening.
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      // Connection refused while the container boots; keep polling.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${label}: ${url}`);
}

function startApi(deploymentPath: string, port: number, logPath: string): number {
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(
      process.execPath,
      ["run", join(REPO_ROOT, "scripts", "tenkacloud-local.ts"), "serve", deploymentPath],
      {
        cwd: REPO_ROOT,
        detached: true,
        env: { ...process.env, LOCAL_API_PORT: String(port) },
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    if (!child.pid) throw new Error("failed to start local Participant API");
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Idempotent: the process may already have exited.
  }
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Restore the participant-portal runtime-config from its backup. When a backup
 * exists it holds the developer's original config — copy it back and drop the
 * backup. Otherwise, remove the local config we wrote (`removeIfNoBackup`) or
 * leave the file alone when we can't tell whether it is ours.
 */
function restoreRuntimeConfig(
  backupPath: string,
  configPath: string,
  removeIfNoBackup: boolean,
): void {
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, configPath);
    unlinkIfExists(backupPath);
  } else if (removeIfNoBackup) {
    unlinkIfExists(configPath);
  }
}

/**
 * [#2392 Phase 2] The real docker adapter for the on-demand lifecycle: a
 * `ContainerRunner` wired to this process's compose / readiness / secret / fs
 * primitives. `serve` injects it into the API; `up` / `down` use it to reclaim
 * recorded units.
 */
function createContainerRunner(localDir: string): ContainerRunner {
  return new ContainerRunner(localDir, {
    runCompose,
    waitForReachable: (url, label) => waitForReachable(url, label),
    generateSecretEnv,
    readCompose: (path) => readFileSync(path, "utf8"),
    writeTempCompose: (path, content) => writeFileSync(path, content, "utf8"),
    removeTempCompose: unlinkIfExists,
    log: (message) => console.log(message),
  });
}

/**
 * Tear down every container recorded in `units.json` (idempotent compose down)
 * and drop the file. Used by `down`, by `up`'s failure cleanup, and by `up` to
 * reclaim leftovers from a crashed previous session before starting a new one.
 */
function tearDownRecordedUnits(p: ReturnType<typeof paths>): void {
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
      console.log(`Challenge — ${problem.name} (${label}): ${url}`);
    }
  }
}

async function up(problemArg: string): Promise<void> {
  const p = paths();
  if (existsSync(p.statePath)) {
    throw new Error("Local play is already running. Run `make local-down` first.");
  }
  assertDockerAvailable();

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
  const catalog = listLocalPlayProblems(roots).map((summary) =>
    loadContainerProblem(resolveProblemDir(roots, summary.problemId)),
  );
  if (catalog.length === 0) {
    throw new Error(
      "No local-play problems found. Run `git submodule update --init` to fetch the problems/ catalog.",
    );
  }
  const catalogIds = new Set(catalog.map((problem) => problem.problemId));
  for (const id of problemIds) {
    if (!catalogIds.has(id)) {
      throw new Error(`problem "${id}" was not found under: ${roots.join(", ")}`);
    }
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
    const deployment: LocalPlayDeployment = { problems: catalog };
    writePrivateJson(p.deploymentPath, deployment);
    apiPid = startApi(p.deploymentPath, apiPort, p.logPath);
    await waitForLocalApi(apiBaseUrl, problemIds, apiPid, p.logPath);

    // Pre-start the requested problems through the API so the serve process's
    // lifecycle owns every container (cap + idle reaping included).
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
      `Local play is ready (catalog: ${catalog.length} problem${catalog.length > 1 ? "s" : ""}, ` +
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
  const p = paths();
  const deployment = readJson<LocalPlayDeployment>(deploymentPath);
  const port = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");

  // [#2392 Phase 2] On-demand docker: the API's lifecycle drives the real
  // ContainerRunner, and every start/stop is mirrored to units.json so `down`
  // (a separate process) can reclaim the containers even after a crash.
  const runner = createContainerRunner(p.localDir);
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
  });

  // Idle sweeper: reclaim containers nobody touched for `idleMs`. Unref'd so
  // the timer alone never keeps the process alive.
  const reaper = setInterval(() => {
    void server.state.lifecycle.reapIdle().catch((error) => {
      console.error(`idle reap failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, REAP_INTERVAL_MS);
  reaper.unref();

  console.log(`Local Participant API listening on http://127.0.0.1:${server.port}`);
  const shutdown = async () => {
    clearInterval(reaper);
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

async function status(): Promise<void> {
  const p = paths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
  await waitForReachable(`${state.apiBaseUrl}/healthz`, "local Participant API", 3_000);
  // A warm session may have pre-started nothing — problems start on demand.
  const preStarted =
    state.problemIds.length > 0 ? state.problemIds.join(", ") : "on-demand, none pre-started";
  console.log(`Local play is running (${preStarted}).`);
  console.log(`Participant API: ${state.apiBaseUrl}`);
}

async function evaluate(flag: string): Promise<void> {
  const p = paths();
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

function down(): void {
  const p = paths();
  if (existsSync(p.statePath)) {
    const state = readJson<LocalProcessState>(p.statePath);
    stopPid(state.pid);
    unlinkIfExists(state.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
    unlinkIfExists(p.statePath);
  } else {
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
  const summaries = listLocalPlayProblems(problemSearchRoots(REPO_ROOT));
  if (summaries.length === 0) {
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
    "  down             Stop local services and remove local state",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
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
      down();
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
