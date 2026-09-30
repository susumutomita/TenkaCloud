import { spawn, spawnSync } from "node:child_process";
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
import {
  assertComposeCommandSucceeded,
  type ComposeCapturedResult,
  type ComposeCli,
  composeArgsForCli,
  composeFailureMessage,
  composeInterpolationEnv,
  generateSecretEnv,
  resolveComposeCli,
} from "../local-host/container/compose-cli";
import { ContainerRunner, type LocalComposeUnit } from "../local-host/container/container-runner";
import { remapComposeHostPorts } from "../local-host/container/port-remap";
import type { PortConflict } from "../local-host/container/problem-lifecycle";
import {
  classifyService,
  LONG_RUNNING_INSPECT_FORMAT,
  looksDiskFull,
  parseComposePs,
  parseLongRunning,
} from "./compose-health";
import { redactDiagnosticLog } from "./diagnostic-redaction";
import type { TerminalProcess } from "./problem-terminal";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

export interface ComposeDiagnosticsDeps {
  readonly cli?: ComposeCli;
  readonly run?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ComposeCapturedResult;
}

function runCapturedCompose(
  cli: ComposeCli,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: ComposeDiagnosticsDeps,
): ComposeCapturedResult {
  return deps.run
    ? deps.run(cli.command, args, env)
    : spawnSync(cli.command, [...args], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
}

function composeProjectPrefix(cli: ComposeCli, unit: LocalComposeUnit): string[] {
  const args = [...cli.prefix, "-f", unit.composePath, "-p", unit.composeProjectName];
  if (unit.projectDirectory) args.push("--project-directory", unit.projectDirectory);
  return args;
}

function serviceStateLine(service: ReturnType<typeof parseComposePs>[number]): string {
  const state = service.state || "unknown";
  const health = service.health || "none";
  return `- ${service.service || service.name || "unknown"}: state=${state}, health=${health}, exit=${service.exitCode}`;
}

function findLongRunningServices(
  services: ReturnType<typeof parseComposePs>,
  env: NodeJS.ProcessEnv,
  deps: ComposeDiagnosticsDeps,
): Set<string> {
  const longRunning = new Set<string>();
  for (const service of services) {
    if (service.state !== "exited" || service.name === "") continue;
    const inspected = runCapturedCompose(
      { command: "docker", prefix: [], label: "docker" },
      ["inspect", service.name, "--format", LONG_RUNNING_INSPECT_FORMAT],
      env,
      deps,
    );
    if (inspected.status !== 0 || parseLongRunning(inspected.stdout ?? "")) {
      longRunning.add(service.name);
    }
  }
  return longRunning;
}

/**
 * Collect bounded, redacted diagnostics for one authenticated compose unit.
 *
 * The caller supplies the exact durable unit; this function never scans by project-name
 * prefix, so a readiness failure cannot cause TenkaCloud to inspect a foreign container.
 */
export function diagnoseComposeUnit(
  unit: LocalComposeUnit,
  sensitiveValues: readonly string[],
  deps: ComposeDiagnosticsDeps = {},
): string | undefined {
  const cli = deps.cli ?? resolveComposeCli();
  const env = composeInterpolationEnv(unit.secretEnv);
  const prefix = composeProjectPrefix(cli, unit);
  const psArgs = [...prefix, "ps", "-a", "--format", "json"];
  const ps = runCapturedCompose(cli, psArgs, env, deps);
  if (ps.status !== 0) {
    return `Container diagnostics unavailable for ${unit.composeProjectName}: compose ps failed.`;
  }

  const services = parseComposePs(ps.stdout ?? "");
  if (services.length === 0) {
    return `Container diagnostics for ${unit.composeProjectName}: no compose services were reported.`;
  }

  const longRunning = findLongRunningServices(services, env, deps);

  const failing = services.filter((service) => {
    const verdict = classifyService(service, longRunning.has(service.name));
    return verdict === "failing" || service.state === "restarting";
  });
  const logTargets = (failing.length > 0 ? failing : services).slice(0, 3);
  const lines = [
    `Container diagnostics for ${unit.composeProjectName}:`,
    ...services.map(serviceStateLine),
  ];
  let diskFull = false;
  for (const service of logTargets) {
    if (!service.service) continue;
    const logs = runCapturedCompose(
      cli,
      [...prefix, "logs", "--no-color", "--tail", "40", service.service],
      env,
      deps,
    );
    const combined = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
    if (looksDiskFull(combined)) diskFull = true;
    const redacted = redactDiagnosticLog(combined, sensitiveValues);
    if (redacted !== "") {
      lines.push(`Logs (tail) for ${service.service}:`, redacted);
    }
  }
  if (diskFull) {
    lines.push(
      'Detected "No space left on device" in container logs.',
      "Next: reclaim Docker VM space manually, for example with `docker builder prune -af` " +
        "and `docker image prune -af`, then retry. TenkaCloud did not run either command.",
    );
  }
  return lines.join("\n");
}

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
 * [#2850] What the terminal needs to know about one compose service before a shell may
 * enter it: whether the service exists in the resolved config, and which image build
 * target it runs. Everything else in the config is irrelevant to that decision.
 */
export interface ComposeServiceBuild {
  /** `build.target` of the service; undefined when the service has no build section. */
  readonly buildTarget?: string;
}

export type ComposeConfigInspector = (
  target: ComposeExecTarget,
) => ReadonlyMap<string, ComposeServiceBuild>;

/**
 * [#2850] Resolve the unit's compose config (`compose config --format json`) and report
 * each declared service's build target. This reads the same file `compose up` ran from —
 * the port-remapped copy when one exists — so what is verified is the configuration the
 * running container was actually created with, not the catalog original.
 */
export const inspectComposeConfig: ComposeConfigInspector = (target) => {
  const cli = resolveComposeCli();
  const base = ["compose", "-f", target.composePath, "-p", target.composeProjectName];
  if (target.projectDirectory) base.push("--project-directory", target.projectDirectory);
  base.push("config", "--format", "json");
  const args = cli.command === "docker-compose" ? base.slice(1) : base;
  const result = spawnSync(cli.command, args, {
    cwd: REPO_ROOT,
    env: composeInterpolationEnv(target.secretEnv),
    encoding: "utf8",
  });
  assertComposeCommandSucceeded(cli, args, result);
  let config: unknown;
  try {
    config = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new Error(`compose config for ${target.composeProjectName} is not valid JSON`, {
      cause: error,
    });
  }
  const services = (config as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) {
    throw new Error(`compose config for ${target.composeProjectName} declares no services`);
  }
  const byName = new Map<string, ComposeServiceBuild>();
  for (const [name, raw] of Object.entries(services)) {
    const build = (raw as { build?: { target?: unknown } } | null)?.build;
    const buildTarget = build?.target;
    byName.set(name, typeof buildTarget === "string" ? { buildTarget } : {});
  }
  return byName;
};

export interface ProblemShellDeps {
  readonly inspectConfig?: ComposeConfigInspector;
  readonly spawnShell?: typeof spawnContainerShell;
}

/**
 * [#2846/#2850] The `serve` process's shell seam for {@link ProblemTerminals}: resolve
 * the problem's live compose unit and `exec` a shell into it.
 *
 * `units` is the running-container ledger `serve` already maintains, so a problem with
 * no recorded unit throws — which the registry reports as `spawn_failed` rather than
 * handing back a session attached to nothing.
 *
 * The shell target is the service the problem's metadata declared in
 * `runtime.terminal.service` — the terminal is per-problem opt-in, and a problem with
 * no declaration is refused here even if a ticket somehow reached attach. Before the
 * shell spawns, the unit's resolved compose config must show that service building with
 * `target: participant`: that stage is the catalog's machine-checkable guarantee that
 * the image excludes author-only material (`reference/`, mutations, hidden tests), and
 * a shell into any other image would read whatever that image holds. Both checks fail
 * closed — no fallback service, no unverified image.
 *
 * Docker is touched only here, on attach — never while merely listing problems.
 */
export function createProblemShellSpawner(
  units: ReadonlyMap<string, LocalComposeUnit>,
  terminalServices: ReadonlyMap<string, string>,
  deps: ProblemShellDeps = {},
): (problemId: string, handlers: ContainerShellHandlers) => TerminalProcess {
  const inspectConfig = deps.inspectConfig ?? inspectComposeConfig;
  const spawnShell = deps.spawnShell ?? spawnContainerShell;
  return (problemId, handlers) => {
    const unit = units.get(problemId);
    if (!unit) throw new Error(`no running container recorded for problem ${problemId}`);
    const service = terminalServices.get(problemId);
    if (service === undefined) {
      throw new Error(
        `problem ${problemId} does not declare runtime.terminal — the terminal is per-problem opt-in`,
      );
    }
    const target: ComposeExecTarget = {
      composePath: unit.composePath,
      composeProjectName: unit.composeProjectName,
      secretEnv: unit.secretEnv,
      ...(unit.projectDirectory ? { projectDirectory: unit.projectDirectory } : {}),
    };
    const declared = inspectConfig(target).get(service);
    if (declared === undefined) {
      throw new Error(
        `terminal service "${service}" of problem ${problemId} is not in its compose config`,
      );
    }
    if (declared.buildTarget !== "participant") {
      throw new Error(
        `terminal service "${service}" of problem ${problemId} must build with ` +
          `target "participant" (got ${declared.buildTarget ?? "no build target"}) — ` +
          "the participant stage is the guarantee that the image holds no author-only material",
      );
    }
    return spawnShell(target, service, handlers);
  };
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
/**
 * [#2927] Which container, if any, publishes `port` on the host right now.
 *
 * `docker ps --filter publish=<port>` asks the daemon rather than this session's own
 * bookkeeping, which is the whole point: the offset pool only knows slots taken *within
 * this session*, so a container a previous session left running is invisible to it.
 * Undefined means the port is free (or the daemon could not be asked, in which case the
 * start proceeds and compose reports the real failure — a probe outage must not become a
 * refusal to start).
 */
export function describePortHolder(port: number): string | undefined {
  // Same trust position as every other docker invocation in this file (the participant's
  // own CLI on their own machine); the others resolve through a variable so only this
  // literal is flagged.
  const result = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- developer-local tooling
    "docker",
    ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return undefined;
  const [first] = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return first;
}

/**
 * [#2927] The lifecycle's port-availability probe, built from the catalog: it resolves the
 * host ports a problem would publish at `offset` and asks the daemon who holds them.
 * Ports this session already owns are not reported (the caller only sees foreign holders).
 */
export function createPortConflictProbe(
  composePathOf: (problemId: string) => string | undefined,
  deps: {
    readonly readCompose?: (path: string) => string;
    readonly holderOf?: (port: number) => string | undefined;
  } = {},
): (problemId: string, offset: number) => readonly PortConflict[] {
  const readCompose = deps.readCompose ?? ((path: string) => readFileSync(path, "utf8"));
  const holderOf = deps.holderOf ?? describePortHolder;
  return (problemId, offset) => {
    const composePath = composePathOf(problemId);
    if (!composePath) return [];
    let portMap: ReadonlyMap<number, number>;
    try {
      portMap = remapComposeHostPorts(readCompose(composePath), offset).portMap;
    } catch {
      // Unreadable compose is this problem's own failure to report, not a port verdict.
      return [];
    }
    // Any holder blocks the bind, whoever it belongs to. The lifecycle only asks about
    // offsets its own pool considers free, so a container found here is by construction
    // not one this session is knowingly running — it is a previous session's leftover, or
    // an unrelated project.
    const conflicts: PortConflict[] = [];
    for (const hostPort of portMap.values()) {
      const holder = holderOf(hostPort);
      if (holder !== undefined) conflicts.push({ port: hostPort, heldBy: holder });
    }
    return conflicts;
  };
}

export function createContainerRunner(localDir: string): ContainerRunner {
  return new ContainerRunner(localDir, {
    runCompose,
    waitForReachable: (url, label) => waitForReachable(url, label),
    diagnoseComposeUnit: (unit, sensitiveValues) => diagnoseComposeUnit(unit, sensitiveValues),
    generateSecretEnv: (problemId, names) => generateSecretEnv(localDir, problemId, names),
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
