import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalComposeUnit } from "./container-runner";
import { deriveSecretEnv, loadOrCreateMasterSecret } from "./problem-secrets";

// The real cause sits at the END of compose stderr; long pull/build logs stay
// in the serve log, only this tail travels into the thrown error.
const COMPOSE_STDERR_TAIL_LINES = 20;

// Daemon-unreachable signatures across Docker Desktop / colima / raw Engine —
// the one failure a player can always self-serve, so it gets an explicit hint.
const DOCKER_DAEMON_UNREACHABLE_RE =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|dial unix .*docker\.sock/i;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  return spawnSync(command, [...args], { stdio: "ignore", env: process.env }).status === 0;
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

/** `compose ps` argv used to verify a recorded unit before adopting it at startup. */
export function composeRunningPsArgs(
  composePath: string,
  projectName: string,
  projectDirectory?: string,
): string[] {
  const base = ["compose", "-f", composePath, "-p", projectName];
  if (projectDirectory) base.push("--project-directory", projectDirectory);
  return [...base, "ps", "--status", "running", "--quiet"];
}

export function composeRunningPsArgsForCli(
  cli: ComposeCli,
  composePath: string,
  projectName: string,
  projectDirectory?: string,
): string[] {
  const args = composeRunningPsArgs(composePath, projectName, projectDirectory);
  if (cli.command !== "docker-compose") return args;

  // Compose v1.29 has no `ps --status`. Its `--filter status=running` is only
  // applied on the `--services` path (not with `--quiet`), so use service names
  // as the non-empty running sentinel on the supported standalone fallback.
  return [...args.slice(1, -4), "ps", "--services", "--filter", "status=running"];
}

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

/**
 * [#2846] Compose still interpolates `${NAME:?...}` when it merely *reads* the file, so
 * `exec` and `config` fail with "required variable is missing" unless every declared
 * `secretEnv` name is set — and the per-deploy secrets live only in the `up` invocation
 * that generated them. A placeholder is enough and is not a leak: the exec'd process
 * inherits the *container's* environment (the real secret, set at creation), never this
 * value. `ContainerRunner.stopPhysical` does the same for `down`.
 */
export function composeInterpolationEnv(secretEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of secretEnv) env[name] = COMPOSE_INTERPOLATION_PLACEHOLDER;
  return env;
}

const COMPOSE_INTERPOLATION_PLACEHOLDER = "tenkacloud-local-exec";

export interface ComposeCapturedResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: { readonly message: string };
}

export function assertComposeCommandSucceeded(
  cli: ComposeCli,
  args: readonly string[],
  result: ComposeCapturedResult,
): void {
  if (result.status === 0) return;
  const stderr = [result.stderr ?? "", result.error?.message ?? ""].filter(Boolean).join("\n");
  throw new Error(composeFailureMessage(`${cli.command} ${args.join(" ")}`, stderr));
}

export interface ComposePsDeps {
  readonly cli?: ComposeCli;
  readonly run?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ComposeCapturedResult;
}

/**
 * [#3016] Verify that a compose unit from this session's durable ledger still has at least
 * one running container. A CLI failure is not interpreted as "stopped": doing that would
 * recreate the exact false-stopped state this probe exists to prevent.
 */
export function isComposeUnitRunning(unit: LocalComposeUnit, deps: ComposePsDeps = {}): boolean {
  const cli = deps.cli ?? resolveComposeCli();
  const args = composeRunningPsArgsForCli(
    cli,
    unit.composePath,
    unit.composeProjectName,
    unit.projectDirectory,
  );
  const env = composeInterpolationEnv(unit.secretEnv);
  const result = deps.run
    ? deps.run(cli.command, args, env)
    : spawnSync(cli.command, args, {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
  assertComposeCommandSucceeded(cli, args, result);
  return (result.stdout ?? "").trim().length > 0;
}

/**
 * A 256-bit hex secret per declared `secretEnv` name, derived from this deployment's
 * master secret and the problem id.
 *
 * It used to be a fresh random draw on every `compose up`, which meant an evicted and
 * restarted container handed the participant different evidence than the one they had
 * been reasoning about — see `problem-secrets.ts` for the measurements (Issue #2975).
 */
export function generateSecretEnv(
  localDir: string,
  problemId: string,
  names: readonly string[],
): Record<string, string> {
  return deriveSecretEnv(loadOrCreateMasterSecret(localDir), problemId, names);
}
