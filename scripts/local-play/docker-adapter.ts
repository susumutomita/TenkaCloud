import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerRunner } from "./container-runner";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * [#2527 Slice 6] The local-play process/container adapter, extracted verbatim from
 * `scripts/tenkacloud-local.ts`: Docker Compose CLI resolution + invocation, per-deploy
 * container secrets, HTTP readiness polling, the real `ContainerRunner` wiring, and the
 * detached serve-process spawn. The CLI entrypoint composes these; nothing here parses
 * commands or presents output beyond compose stderr re-echo.
 */

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

export type CommandSucceeds = (command: string, args: readonly string[]) => boolean;

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
  // [#2851] Always ask Compose to build. Docker layer caching keeps unchanged starts cheap,
  // while changed problem sources and submodule pins can no longer reuse a stale image.
  return action === "up"
    ? [...base, "up", "-d", "--build"]
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

// The real cause sits at the END of compose stderr; long pull/build logs stay
// in the serve log, only this tail travels into the thrown error.
const COMPOSE_STDERR_TAIL_LINES = 20;

// Daemon-unreachable signatures across Docker Desktop / colima / raw Engine —
// the one failure a player can always self-serve, so it gets an explicit hint.
const DOCKER_DAEMON_UNREACHABLE_RE =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|dial unix .*docker\.sock/i;

/**
 * Build the error message for a failed compose invocation. The portal surfaces
 * this verbatim (`start_failed`), so it must carry the cause: the stderr tail,
 * plus a "start your Docker daemon" hint when that is what stderr says.
 */
export function composeFailureMessage(commandLine: string, stderr: string): string {
  const trimmed = stderr.trim();
  const parts = [`${commandLine} failed`];
  if (trimmed !== "") {
    parts.push(trimmed.split("\n").slice(-COMPOSE_STDERR_TAIL_LINES).join("\n"));
  }
  if (DOCKER_DAEMON_UNREACHABLE_RE.test(trimmed)) {
    parts.push(
      "The Docker daemon looks unreachable — start Docker Desktop (or `colima start` / " +
        "`sudo systemctl start docker`), then retry.",
    );
  }
  return parts.join("\n");
}

export function runCompose(
  composePath: string,
  projectName: string,
  action: "up" | "down",
  env: NodeJS.ProcessEnv,
  allowFailure = false,
  projectDirectory?: string,
): void {
  const cli = resolveComposeCli();
  const args = composeArgsForCli(cli, composePath, projectName, action, projectDirectory);
  // stderr is piped (not inherited) so a failure can carry its cause into the
  // thrown error — the portal used to show a bare "... failed" while the real
  // reason sat stranded in the detached serve log. It is re-echoed below so
  // that log keeps the full output.
  const result = spawnSync(cli.command, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
  });
  const stderr = [result.stderr ?? "", result.error?.message ?? ""].filter(Boolean).join("\n");
  if (stderr !== "") process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  if (!allowFailure && result.status !== 0) {
    throw new Error(composeFailureMessage(`${cli.command} ${args.join(" ")}`, stderr));
  }
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

export async function waitForReachable(
  url: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
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

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * [#2392 Phase 2] The real docker adapter for the on-demand lifecycle: a
 * `ContainerRunner` wired to this process's compose / readiness / secret / fs
 * primitives. `serve` injects it into the API; `up` / `down` use it to reclaim
 * recorded units.
 */
export function createContainerRunner(localDir: string): ContainerRunner {
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
 * Spawn the detached serve process (`tenkacloud-local.ts serve <deploymentPath>`)
 * that owns the local Participant API and its containers; stdout/stderr append to
 * the session log. Returns the child pid.
 */
export function startDetachedServe(deploymentPath: string, port: number, logPath: string): number {
  const logFd = openPrivateAppendLog(logPath);
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

export function openPrivateAppendLog(logPath: string): number {
  const logFd = openSync(
    logPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(logFd, 0o600);
  return logFd;
}
