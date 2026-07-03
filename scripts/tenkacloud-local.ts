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
import {
  listLocalPlayProblems,
  loadContainerProblem,
  resolveProblemDir,
} from "./local-play/manifest";
import { runSearchableProblemPicker } from "./local-play/picker";
import { assertPortFree, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import { buildRuntimeConfig } from "./participant-portal-runtime-config";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROBLEM = "sqli-demo";
const DEFAULT_API_PORT = 3199;

interface LocalProcessState {
  readonly pid: number;
  readonly apiBaseUrl: string;
  readonly problemId: string;
  readonly composePath: string;
  readonly composeProjectName: string;
  readonly secretEnv: readonly string[];
  readonly deploymentPath: string;
  readonly runtimeConfigPath: string;
  readonly runtimeConfigBackupPath?: string;
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
): string[] {
  const base = ["compose", "-f", composePath, "-p", projectName];
  return action === "up"
    ? [...base, "up", "-d", "--wait"]
    : [...base, "down", "--volumes", "--remove-orphans"];
}

export function buildLocalRuntimeConfig(apiBaseUrl: string) {
  // `out`/`print` are unused by buildRuntimeConfig (it returns the object; up()
  // writes the file itself) — pass inert values to satisfy the option type.
  return buildRuntimeConfig({
    cloudMode: "local",
    portalMode: "backend",
    apiBaseUrl,
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
  const result = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      "Docker (with the compose plugin) is required for local play. Install Docker Desktop / Engine and retry.",
    );
  }
}

function runCompose(
  composePath: string,
  projectName: string,
  action: "up" | "down",
  env: NodeJS.ProcessEnv,
  allowFailure = false,
): void {
  const result = spawnSync("docker", composeArgs(composePath, projectName, action), {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${composeArgs(composePath, projectName, action).join(" ")} failed`);
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

async function up(problemId: string): Promise<void> {
  const p = paths();
  if (existsSync(p.statePath)) {
    throw new Error("Local play is already running. Run `make local-down` first.");
  }
  assertDockerAvailable();

  const problemDir = resolveProblemDir(problemSearchRoots(REPO_ROOT), problemId);
  const problem = loadContainerProblem(problemDir);
  const apiPort = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  await assertPortFree(apiPort, "Participant API");

  mkdirSync(p.localDir, { recursive: true });
  const secretEnv = generateSecretEnv(problem.secretEnv);
  const composeEnv: NodeJS.ProcessEnv = { ...process.env, ...secretEnv };

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
    console.log(`Starting problem container for ${problem.name}...`);
    runCompose(problem.composePath, problem.composeProjectName, "up", composeEnv);
    await Promise.all(
      Object.entries(problem.challengeEndpoints).map(([label, url]) =>
        waitForReachable(url, `challenge endpoint ${label}`),
      ),
    );

    const deployment: LocalPlayDeployment = { problem };
    writePrivateJson(p.deploymentPath, deployment);
    apiPid = startApi(p.deploymentPath, apiPort, p.logPath);
    await waitForLocalApi(apiBaseUrl, problem.problemId, apiPid, p.logPath);

    const runtimeConfig = buildLocalRuntimeConfig(apiBaseUrl);
    writeFileSync(p.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");

    const state: LocalProcessState = {
      pid: apiPid,
      apiBaseUrl,
      problemId: problem.problemId,
      composePath: problem.composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
      deploymentPath: p.deploymentPath,
      runtimeConfigPath: p.runtimeConfigPath,
      ...(runtimeConfigBackedUp ? { runtimeConfigBackupPath: p.runtimeConfigBackupPath } : {}),
    };
    writePrivateJson(p.statePath, state);

    console.log(`Local play is ready: ${problem.name}`);
    console.log(`Participant API: ${apiBaseUrl}`);
    for (const [label, url] of Object.entries(problem.challengeEndpoints)) {
      console.log(`Challenge (${label}): ${url}`);
    }
    console.log("Log in to the Participant Portal with any non-empty key.");
  } catch (error) {
    if (apiPid !== undefined) stopPid(apiPid);
    unlinkIfExists(p.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
    runCompose(problem.composePath, problem.composeProjectName, "down", composeEnv, true);
    throw error;
  }
}

async function serve(deploymentPath: string): Promise<void> {
  if (!existsSync(deploymentPath)) {
    throw new Error(`Local deployment state was not found: ${deploymentPath}`);
  }
  const deployment = readJson<LocalPlayDeployment>(deploymentPath);
  const port = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");
  const server = await startLocalPlayServer(port, deployment);
  console.log(`Local Participant API listening on http://127.0.0.1:${server.port}`);
  const shutdown = async () => {
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
  console.log(`Local play is running (${state.problemId}).`);
  console.log(`Participant API: ${state.apiBaseUrl}`);
}

async function evaluate(flag: string): Promise<void> {
  const p = paths();
  if (!existsSync(p.statePath)) throw new Error("Local play is not running.");
  const state = readJson<LocalProcessState>(p.statePath);
  const response = await fetch(`${state.apiBaseUrl}/portal/me/submit-flag`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({ problemId: state.problemId, flag }),
  });
  const outcome = (await response.json()) as { kind?: string };
  console.log(JSON.stringify(outcome, null, 2));
  if (!response.ok || outcome.kind === "wrong") process.exitCode = 1;
}

function down(): void {
  const p = paths();
  let composePath: string | undefined;
  let projectName: string | undefined;
  let secretNames: readonly string[] = [];
  if (existsSync(p.statePath)) {
    const state = readJson<LocalProcessState>(p.statePath);
    stopPid(state.pid);
    composePath = state.composePath;
    projectName = state.composeProjectName;
    secretNames = state.secretEnv;
    unlinkIfExists(state.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
    unlinkIfExists(p.statePath);
  } else {
    unlinkIfExists(p.deploymentPath);
    restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, false);
  }
  if (composePath && projectName) {
    // Blank the per-deploy secret names so compose interpolation does not warn
    // during teardown (the values are irrelevant to `down`).
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of secretNames) env[name] = "";
    runCompose(composePath, projectName, "down", env, true);
  }
  console.log("Local play stopped.");
}

/**
 * Issue #2188: `make local list` — show which problems are playable locally
 * (id / display name / category) so players can pick one instead of already
 * needing to know the id.
 */
function listProblems(): void {
  const summaries = listLocalPlayProblems(problemSearchRoots(REPO_ROOT));
  if (summaries.length === 0) {
    console.log(
      "No local-play problems found. Run `git submodule update --init` (or `make doctor` / " +
        "`make local`, which do this for you) to fetch the problems/ catalog.",
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

/**
 * Issue #2188 follow-up: full-screen searchable problem picker. The TUI is
 * rendered to stderr and the single chosen id goes to stdout, so `make local`
 * can capture it with command substitution. Only invoked for an interactive run
 * with no explicit PROBLEM; non-TTY invocation exits non-zero rather than
 * hanging or silently defaulting.
 */
async function pick(): Promise<void> {
  const summaries = listLocalPlayProblems(problemSearchRoots(REPO_ROOT));
  if (summaries.length === 0) {
    process.stderr.write(
      "No local-play problems found. Run `git submodule update --init` (or `make doctor`) " +
        "to fetch the problems/ catalog.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(
      "Not a terminal. Re-run `make local PROBLEM=<id>` (see `make local-list`).\n",
    );
    process.exitCode = 1;
    return;
  }
  const chosen = await runSearchableProblemPicker(summaries);
  if (chosen) {
    process.stdout.write(`${chosen}\n`);
    return;
  }
  process.stderr.write("No problem selected. Re-run `make local PROBLEM=<id>`.\n");
  process.exitCode = 1;
}

function usage(): string {
  return [
    "Usage: bun run scripts/tenkacloud-local.ts <command>",
    "",
    "Commands:",
    "  list             List local-play problems (id / category / name)",
    "  pick             Interactively search for a problem (prints the id to stdout)",
    "  up [problemId]   Start the problem container and the local scoring API",
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
    case "pick":
      await pick();
      break;
    case "up":
      await up(argument ?? process.env.PROBLEM ?? DEFAULT_PROBLEM);
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
