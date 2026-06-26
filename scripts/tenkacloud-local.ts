import { spawn, spawnSync } from "node:child_process";
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
import { loadLocalFlagProblem } from "./local-play/catalog";
import { deployProblemToKumo, type LocalPlayDeployment } from "./local-play/kumo";
import { assertPortFree, waitForLocalApi } from "./local-play/readiness";
import { startLocalPlayServer } from "./local-play/server";
import { buildRuntimeConfig } from "./participant-portal-runtime-config";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROBLEM = "hello-world";
const DEFAULT_KUMO_PORT = 4566;
const DEFAULT_API_PORT = 3199;

interface LocalProcessState {
  readonly pid: number;
  readonly apiBaseUrl: string;
  readonly kumoEndpoint: string;
  readonly problemId: string;
  readonly stackName: string;
  readonly deploymentPath: string;
  readonly runtimeConfigPath: string;
  readonly runtimeConfigBackupPath?: string;
}

function positivePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function paths() {
  const localDir = process.env.TENKACLOUD_LOCAL_DIR ?? join(REPO_ROOT, ".tenkacloud", "local");
  return {
    localDir,
    statePath: join(localDir, "state.json"),
    deploymentPath: join(localDir, "deployment.json"),
    runtimeConfigBackupPath: join(localDir, "runtime-config.backup.json"),
    logPath: join(localDir, "api.log"),
    composePath: join(REPO_ROOT, "docker-compose.kumo.yml"),
    runtimeConfigPath: join(
      REPO_ROOT,
      "apps",
      "participant-portal",
      "public",
      "runtime-config.json",
    ),
  };
}

function runCompose(args: readonly string[], allowFailure = false): void {
  const result = spawnSync("docker", ["compose", "-f", paths().composePath, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed`);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
}

async function waitForUrl(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service startup is expected to race the first requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
    // Idempotent cleanup: the process may already have exited.
  }
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

async function up(problemId: string): Promise<void> {
  const localPaths = paths();
  if (existsSync(localPaths.statePath)) {
    throw new Error("Local play state already exists. Run `make local-down` first.");
  }
  mkdirSync(localPaths.localDir, { recursive: true });
  const kumoPort = positivePort(process.env.KUMO_PORT, DEFAULT_KUMO_PORT, "KUMO_PORT");
  const apiPort = positivePort(process.env.LOCAL_API_PORT, DEFAULT_API_PORT, "LOCAL_API_PORT");
  const kumoEndpoint = `http://127.0.0.1:${kumoPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  let apiPid: number | undefined;
  let runtimeConfigBackedUp = false;
  if (existsSync(localPaths.runtimeConfigPath)) {
    copyFileSync(localPaths.runtimeConfigPath, localPaths.runtimeConfigBackupPath);
    runtimeConfigBackedUp = true;
  }

  // Fail loudly *before* touching Docker if the API port is taken, so we never
  // silently adopt a stale/foreign server squatting on it.
  await assertPortFree(apiPort, "local Participant API");

  try {
    runCompose(["up", "-d", "--wait"]);
    await waitForUrl(`${kumoEndpoint}/health`, "Kumo");
    const problem = loadLocalFlagProblem(join(REPO_ROOT, "problems"), problemId);
    console.log(`Deploying ${problemId} to Kumo...`);
    const deployment = await deployProblemToKumo(problem, kumoEndpoint);
    writePrivateJson(localPaths.deploymentPath, deployment);

    apiPid = startApi(localPaths.deploymentPath, apiPort, localPaths.logPath);
    await waitForLocalApi(apiBaseUrl, problemId, apiPid, localPaths.logPath);

    const runtimeConfig = buildRuntimeConfig({
      cloudMode: "localstack",
      portalMode: "backend",
      apiBaseUrl,
      eventTitle: "TenkaCloud Local (Kumo)",
      eventRegion: "local",
      localstackEndpoint: kumoEndpoint,
      out: localPaths.runtimeConfigPath,
      print: false,
    });
    writeFileSync(
      localPaths.runtimeConfigPath,
      `${JSON.stringify(runtimeConfig, null, 2)}\n`,
      "utf8",
    );

    const state: LocalProcessState = {
      pid: apiPid,
      apiBaseUrl,
      kumoEndpoint,
      problemId,
      stackName: deployment.stackName,
      deploymentPath: localPaths.deploymentPath,
      runtimeConfigPath: localPaths.runtimeConfigPath,
      ...(runtimeConfigBackedUp
        ? { runtimeConfigBackupPath: localPaths.runtimeConfigBackupPath }
        : {}),
    };
    writePrivateJson(localPaths.statePath, state);
    console.log(`Local play is ready: ${problem.name}`);
    console.log(`Participant API: ${apiBaseUrl}`);
    console.log(`Kumo endpoint:   ${kumoEndpoint}`);
    console.log("Login to the Participant Portal with any non-empty key.");
  } catch (error) {
    if (apiPid !== undefined) stopPid(apiPid);
    unlinkIfExists(localPaths.deploymentPath);
    if (runtimeConfigBackedUp) {
      copyFileSync(localPaths.runtimeConfigBackupPath, localPaths.runtimeConfigPath);
      unlinkIfExists(localPaths.runtimeConfigBackupPath);
    } else {
      unlinkIfExists(localPaths.runtimeConfigPath);
    }
    runCompose(["down", "--volumes", "--remove-orphans"], true);
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
  const localPaths = paths();
  if (!existsSync(localPaths.statePath)) {
    throw new Error("Local play is not running.");
  }
  const state = readJson<LocalProcessState>(localPaths.statePath);
  await waitForUrl(`${state.apiBaseUrl}/healthz`, "local Participant API", 2_000);
  await waitForUrl(`${state.kumoEndpoint}/health`, "Kumo", 2_000);
  console.log(`Local play is running (${state.problemId}).`);
  console.log(`Participant API: ${state.apiBaseUrl}`);
  console.log(`Kumo endpoint:   ${state.kumoEndpoint}`);
}

async function evaluate(flag: string): Promise<void> {
  const localPaths = paths();
  if (!existsSync(localPaths.statePath)) {
    throw new Error("Local play is not running.");
  }
  const state = readJson<LocalProcessState>(localPaths.statePath);
  const response = await fetch(`${state.apiBaseUrl}/portal/me/submit-flag`, {
    method: "POST",
    headers: {
      authorization: "Bearer local",
      "content-type": "application/json",
    },
    body: JSON.stringify({ problemId: state.problemId, flag }),
  });
  if (!response.ok) throw new Error(`Local scoring API returned HTTP ${response.status}`);
  const outcome = (await response.json()) as { kind?: string; totalScore?: number };
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.kind === "wrong") process.exitCode = 1;
}

function down(): void {
  const localPaths = paths();
  if (existsSync(localPaths.statePath)) {
    const state = readJson<LocalProcessState>(localPaths.statePath);
    stopPid(state.pid);
    unlinkIfExists(state.deploymentPath);
    if (state.runtimeConfigBackupPath && existsSync(state.runtimeConfigBackupPath)) {
      copyFileSync(state.runtimeConfigBackupPath, state.runtimeConfigPath);
      unlinkIfExists(state.runtimeConfigBackupPath);
    } else {
      unlinkIfExists(state.runtimeConfigPath);
    }
    unlinkIfExists(localPaths.statePath);
  } else {
    unlinkIfExists(localPaths.deploymentPath);
    if (existsSync(localPaths.runtimeConfigBackupPath)) {
      copyFileSync(localPaths.runtimeConfigBackupPath, localPaths.runtimeConfigPath);
      unlinkIfExists(localPaths.runtimeConfigBackupPath);
    }
  }
  runCompose(["down", "--volumes", "--remove-orphans"], true);
  console.log("Local play stopped.");
}

function usage(): string {
  return [
    "Usage: bun run scripts/tenkacloud-local.ts <command>",
    "",
    "Commands:",
    "  up [problemId]   Start Kumo, deploy one flag problem, and start the local API",
    "  serve <path>     Run the local Participant API (used internally by up)",
    "  status           Check Kumo and the local Participant API",
    "  evaluate <flag>  Submit a flag through the local scoring API",
    "  down             Stop local services and remove local state",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
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
