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
import { ContainerRunner, type LocalComposeUnit } from "./container-runner";
import type { TerminalProcess } from "./problem-terminal";

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
  // [#2851] `up -d` alone reuses an already-built image even when the problem's
  // build context changed, so edited problems kept starting from stale images.
  // `--build` re-runs the build for services with a `build:` section (layer
  // cache keeps the no-change case fast) and leaves image-only services alone.
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

/**
 * [#2846] `compose exec` argv for attaching a shell to a running service.
 *
 * `-T` disables TTY allocation. This process's stdin is a pipe, and `compose exec`
 * with a TTY refuses to start against one ("the input device is not a TTY"). Commands
 * and output still flow both ways; what is lost is line editing, a shell prompt, and
 * anything curses-based. A real TTY needs a pty on this side (`node-pty`), a native
 * module deliberately not taken on yet.
 */
export function composeExecArgs(
  composePath: string,
  projectName: string,
  service: string,
  command: readonly string[],
  projectDirectory?: string,
): string[] {
  const base = ["compose", "-f", composePath, "-p", projectName];
  if (projectDirectory) base.push("--project-directory", projectDirectory);
  return [...base, "exec", "-T", service, ...command];
}

export function composeExecArgsForCli(
  cli: ComposeCli,
  composePath: string,
  projectName: string,
  service: string,
  command: readonly string[],
  projectDirectory?: string,
): string[] {
  const args = composeExecArgs(composePath, projectName, service, command, projectDirectory);
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

/**
 * [#2846] POSIX `sh`, not `bash -i`. Every problem base image has `/bin/sh`, and
 * without a TTY an interactive bash spends its first three lines complaining about
 * job control it cannot have. Reading commands from the pipe is what we actually
 * want: one line in, its output back.
 */
const CONTAINER_SHELL_COMMAND = ["/bin/sh"] as const;

/** The compose coordinates needed to exec into one problem's container. */
export interface ComposeExecTarget {
  readonly composePath: string;
  readonly composeProjectName: string;
  readonly projectDirectory?: string;
  /** Declared `secretEnv` names; see {@link composeInterpolationEnv} for why they matter. */
  readonly secretEnv?: readonly string[];
}

/**
 * [#2846] Compose still interpolates `${NAME:?...}` when it merely *reads* the file, so
 * `exec` and `config` fail with "required variable is missing" unless every declared
 * `secretEnv` name is set — and the per-deploy secrets live only in the `up` invocation
 * that generated them. A placeholder is enough and is not a leak: the exec'd process
 * inherits the *container's* environment (the real secret, set at creation), never this
 * value. `ContainerRunner.stopPhysical` does the same for `down`.
 */
function composeInterpolationEnv(secretEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of secretEnv) env[name] = COMPOSE_INTERPOLATION_PLACEHOLDER;
  return env;
}

const COMPOSE_INTERPOLATION_PLACEHOLDER = "tenkacloud-local-exec";

/**
 * [#2846] Real shell adapter behind {@link ProblemTerminals}: `compose exec` into a
 * running service and expose it as the registry's process contract.
 *
 * stderr is merged into the data stream rather than dropped — the participant needs
 * a traceback as much as a result, and a terminal that silently swallows stderr
 * makes a failing command look like a hanging one.
 */
export interface ContainerShellHandlers {
  /** Merged stdout/stderr from the shell. */
  readonly onData: (chunk: string) => void;
  /** Fires once when the shell ends, for any reason. */
  readonly onExit: (code: number | null) => void;
}

export function spawnContainerShell(
  target: ComposeExecTarget,
  service: string,
  handlers: ContainerShellHandlers,
): TerminalProcess {
  const cli = resolveComposeCli();
  const args = composeExecArgsForCli(
    cli,
    target.composePath,
    target.composeProjectName,
    service,
    CONTAINER_SHELL_COMMAND,
    target.projectDirectory,
  );
  const child = spawn(cli.command, args, {
    cwd: REPO_ROOT,
    env: composeInterpolationEnv(target.secretEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", handlers.onData);
  child.stderr?.on("data", handlers.onData);
  // `error` fires instead of `close` when the CLI itself cannot be spawned. Report
  // the reason through the same stream the participant is already reading.
  child.on("error", (error) => {
    handlers.onData(`${error.message}\n`);
    handlers.onExit(null);
  });
  child.on("close", (code) => handlers.onExit(code));
  return {
    write: (data) => {
      child.stdin?.write(data);
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
}

/**
 * [#2846] The services a problem's compose file declares, in `compose config --services`
 * order (compose sorts them alphabetically, it is not file order).
 */
export type ComposeServiceLister = (target: ComposeExecTarget) => readonly string[];

export const listComposeServices: ComposeServiceLister = (target) => {
  const cli = resolveComposeCli();
  const base = ["compose", "-f", target.composePath, "-p", target.composeProjectName];
  if (target.projectDirectory) base.push("--project-directory", target.projectDirectory);
  base.push("config", "--services");
  const args = cli.command === "docker-compose" ? base.slice(1) : base;
  const result = spawnSync(cli.command, args, {
    cwd: REPO_ROOT,
    env: composeInterpolationEnv(target.secretEnv),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = [result.stderr ?? "", result.error?.message ?? ""].filter(Boolean).join("\n");
    throw new Error(composeFailureMessage(`${cli.command} ${args.join(" ")}`, stderr));
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
};

export interface ProblemShellDeps {
  readonly listServices?: ComposeServiceLister;
  readonly spawnShell?: typeof spawnContainerShell;
}

/**
 * [#2846] The `serve` process's shell seam for {@link ProblemTerminals}: resolve the
 * problem's live compose unit and `exec` a shell into it.
 *
 * `units` is the running-container ledger `serve` already maintains, so a problem with
 * no recorded unit throws — which the registry reports as `spawn_failed` rather than
 * handing back a session attached to nothing.
 *
 * The shell target is the FIRST declared service. Every problem in the track this
 * terminal exists for (the AC26 companion series, the sha256 series) declares exactly
 * one, so the choice is unambiguous there; a multi-service problem gets whichever name
 * sorts first, which is not necessarily the one worth a shell.
 *
 * Docker is touched only here, on attach — never while merely listing problems.
 */
export function createProblemShellSpawner(
  units: ReadonlyMap<string, LocalComposeUnit>,
  deps: ProblemShellDeps = {},
): (problemId: string, handlers: ContainerShellHandlers) => TerminalProcess {
  const listServices = deps.listServices ?? listComposeServices;
  const spawnShell = deps.spawnShell ?? spawnContainerShell;
  return (problemId, handlers) => {
    const unit = units.get(problemId);
    if (!unit) throw new Error(`no running container recorded for problem ${problemId}`);
    const target: ComposeExecTarget = {
      composePath: unit.composePath,
      composeProjectName: unit.composeProjectName,
      secretEnv: unit.secretEnv,
      ...(unit.projectDirectory ? { projectDirectory: unit.projectDirectory } : {}),
    };
    const service = listServices(target)[0];
    if (service === undefined) {
      throw new Error(`compose file for problem ${problemId} declares no service`);
    }
    return spawnShell(target, service, handlers);
  };
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
