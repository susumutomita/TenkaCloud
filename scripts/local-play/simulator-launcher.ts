import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { compareCodePoints } from "../lib/code-point-order";
import { isLoopbackUrl } from "./loopback";
import { observeProcessIdentity, processIdentityFromStartTime } from "./process-identity";
import { readPrivateJson, unlinkIfExists, writePrivateText } from "./session-state";
import { createSimulatorLaunchSecret, decodeSimulatorLaunchSecret } from "./simulator-auth";
import {
  clearSimulatorLaunchIntent,
  createNativeCredentials,
  DEFAULT_DOCKER_SOCKET,
  DEFAULT_SIMULATOR_IMAGE,
  expectedOwnershipLeasePath,
  expectedRegistrationPath,
  externalNativeCredentials,
  IMAGE_DIGEST,
  isRecord,
  LAUNCH_INTENT_VERSION,
  LAUNCH_REGISTRATION_TIMEOUT_MS,
  LAUNCHER_STOP_TIMEOUT_MS,
  MAX_WORKLOAD_IMAGES,
  nativeCredentialEnv,
  readSimulatorLaunchIntent,
  releaseProcessLaunchFiles,
  SAFE_PROCESS_ENVIRONMENT_KEYS,
  type SimulatorLauncherRecord,
  type SimulatorOwnedLaunchIntent,
  type SimulatorProcessRegistration,
  simulatorLaunchIntentPath,
  WORKLOAD_IMAGE_DIGEST,
  WORKLOAD_PROXY_IMAGE,
  writeSimulatorLaunchIntent,
} from "./simulator-launch-state";

export {
  clearSimulatorLaunchIntent,
  DEFAULT_SIMULATOR_IMAGE,
  readSimulatorLaunchIntent,
  type SimulatorLauncherKind,
  type SimulatorLauncherRecord,
  type SimulatorLaunchPreparation,
  type SimulatorNativeCredentials,
  type SimulatorOwnedLaunchIntent,
  simulatorLaunchIntentPath,
  writeSimulatorLaunchIntent,
} from "./simulator-launch-state";

export interface SimulatorLauncherOptions {
  readonly stateDir: string;
  readonly logPath: string;
  /** Optional durable session path used to place process ownership files. */
  readonly sessionPath?: string;
  readonly workloadImages?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export type SimulatorSource =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "process"; readonly command: string }
  | { readonly kind: "container"; readonly image: string };

/** Resolve one explicit override, or the reviewed immutable default image. */
export function resolveSimulatorSource(env: NodeJS.ProcessEnv): SimulatorSource {
  const externalUrl = env.TENKACLOUD_SIMULATOR_URL?.trim();
  const command = env.TENKACLOUD_SIMULATOR_COMMAND?.trim();
  const explicitImage = env.TENKACLOUD_SIMULATOR_IMAGE?.trim();
  const configured = [externalUrl, command, explicitImage].filter((value) => value).length;
  if (configured > 1) {
    throw new Error("Configure exactly one Simulator source (command, image, or URL)");
  }
  if (externalUrl) return { kind: "external", url: externalUrl };
  if (command) return { kind: "process", command };
  return { kind: "container", image: explicitImage ?? DEFAULT_SIMULATOR_IMAGE };
}

function normalizedWorkloadImages(images: readonly string[] | undefined): readonly string[] {
  const requested = images ?? [];
  if (
    requested.length > MAX_WORKLOAD_IMAGES - 1 ||
    requested.some((image) => !WORKLOAD_IMAGE_DIGEST.test(image))
  ) {
    throw new Error("Simulator workload images must be digest-pinned catalog references");
  }
  return [...new Set([...(requested.length > 0 ? [WORKLOAD_PROXY_IMAGE] : []), ...requested])].sort(
    compareCodePoints,
  );
}

function workloadEnvironment(
  images: readonly string[],
  controlContainer?: string,
): Readonly<Record<string, string>> {
  if (images.length === 0) return {};
  return {
    TENKACLOUD_SIMULATOR_WORKLOAD_ALLOWED_IMAGES: JSON.stringify(images),
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MEMORY_BYTES: "536870912",
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MILLI_CPU: "1000",
    TENKACLOUD_SIMULATOR_WORKLOAD_MAX_PIDS: "128",
    TENKACLOUD_SIMULATOR_WORKLOAD_PROXY_IMAGE: WORKLOAD_PROXY_IMAGE,
    ...(controlContainer
      ? { TENKACLOUD_SIMULATOR_WORKLOAD_CONTROL_CONTAINER: controlContainer }
      : {}),
  };
}

function simulatorBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackUrl(url.toString())) {
    throw new Error("TENKACLOUD_SIMULATOR_URL must be an http:// loopback URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("TENKACLOUD_SIMULATOR_URL must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function privateStateDir(path: string): string {
  if (!isAbsolute(path)) throw new Error("Simulator state directory must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Simulator state directory must not be a symlink");
  chmodSync(path, 0o700);
  return realpathSync(path);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("failed to reserve a loopback port for Simulator");
  return port;
}

function commandArgs(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("TENKACLOUD_SIMULATOR_ARGS must be a JSON string array");
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.includes("\0"))
  ) {
    throw new Error("TENKACLOUD_SIMULATOR_ARGS must be a JSON string array");
  }
  return value;
}

function assertExecutable(command: string): void {
  if (!isAbsolute(command)) {
    throw new Error("TENKACLOUD_SIMULATOR_COMMAND must be an absolute executable path");
  }
  accessSync(command, constants.X_OK);
}

function safeProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_PROCESS_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function processRegistration(value: unknown): SimulatorProcessRegistration {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    typeof value.startTime !== "string" ||
    !/^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d [\d:]{8} \d{4}$/.test(value.startTime.trim())
  ) {
    throw new Error("Simulator process launch registration is invalid");
  }
  const hasChild = value.childPid !== undefined || value.childStartTime !== undefined;
  if (
    hasChild &&
    (!Number.isSafeInteger(value.childPid) ||
      Number(value.childPid) < 1 ||
      typeof value.childStartTime !== "string" ||
      !/^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d [\d:]{8} \d{4}$/.test(value.childStartTime.trim()))
  ) {
    throw new Error("Simulator child process launch registration is invalid");
  }
  return {
    pid: Number(value.pid),
    startTime: value.startTime.trim(),
    ...(hasChild
      ? {
          childPid: Number(value.childPid),
          childStartTime: String(value.childStartTime).trim(),
        }
      : {}),
  };
}

function readProcessRegistration(path: string): SimulatorProcessRegistration | undefined {
  if (!existsSync(path)) return undefined;
  return processRegistration(readPrivateJson<unknown>(path, 4 * 1024));
}

async function waitForProcessRegistration(
  path: string,
  expectedPid: number | undefined,
  timeoutMs = LAUNCH_REGISTRATION_TIMEOUT_MS,
  requireChild = false,
): Promise<SimulatorProcessRegistration | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const registration = readProcessRegistration(path);
      if (
        registration &&
        (expectedPid === undefined || registration.pid === expectedPid) &&
        (!requireChild || registration.childPid !== undefined)
      ) {
        return registration;
      }
    } catch {
      // A writer may be between its private temporary file and atomic rename.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

async function startProcess(
  intent: Extract<SimulatorOwnedLaunchIntent, { kind: "process" }>,
  env: NodeJS.ProcessEnv,
): Promise<SimulatorLauncherRecord> {
  assertExecutable(intent.command);
  const logFd = openSync(
    intent.logPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  // The real command cannot run until this wrapper has durably published its
  // identity. Even a first-instruction SIGKILL of the supervisor therefore
  // leaves reconcile with an exact child handle instead of an orphan window.
  const childRegistrationScript = [
    "set -eu",
    'registration="$1"',
    'lease="$2"',
    'supervisor_pid="$3"',
    'supervisor_start_time="$4"',
    "shift 4",
    '[ -f "$lease" ] || exit 0',
    'child_pid="$$"',
    'child_start_time="$(LC_ALL=C /bin/ps -p "$child_pid" -o lstart=)"',
    `temporary="\${registration}.child.\${child_pid}"`,
    "umask 077",
    `printf '{"pid":%s,"startTime":"%s","childPid":%s,"childStartTime":"%s"}\\n' "$supervisor_pid" "$supervisor_start_time" "$child_pid" "$child_start_time" > "$temporary"`,
    '/bin/mv -f "$temporary" "$registration"',
    'if [ ! -f "$lease" ]; then',
    '  /bin/unlink "$registration" 2>/dev/null || true',
    "  exit 0",
    "fi",
    'exec "$@"',
  ].join("\n");
  const registrationScript = [
    "set -eu",
    'registration="$1"',
    'lease="$2"',
    'child_registration_script="$3"',
    "shift 3",
    'child_pid=""',
    "terminate() {",
    "  trap '' HUP INT TERM",
    '  kill -TERM -- "-$$" 2>/dev/null || true',
    "  wait 2>/dev/null || true",
    "  exit 0",
    "}",
    "trap terminate HUP INT TERM",
    `temporary="\${registration}.tmp.$$"`,
    "umask 077",
    'start_time="$(LC_ALL=C /bin/ps -p "$$" -o lstart=)"',
    `printf '{"pid":%s,"startTime":"%s"}\\n' "$$" "$start_time" > "$temporary"`,
    '/bin/mv -f "$temporary" "$registration"',
    '[ -f "$lease" ] || exit 0',
    '/bin/sh -c "$child_registration_script" tenkacloud-simulator-child "$registration" "$lease" "$$" "$start_time" "$@" &',
    'child_pid="$!"',
    '[ -f "$lease" ] || terminate',
    'while kill -0 "$child_pid" 2>/dev/null; do',
    '  [ -f "$lease" ] || terminate',
    "  sleep 0.05",
    "done",
    'wait "$child_pid"',
  ].join("\n");
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      registrationScript,
      "tenkacloud-simulator-launch",
      intent.registrationPath,
      intent.ownershipLeasePath,
      childRegistrationScript,
      intent.command,
      ...intent.args,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...safeProcessEnvironment(env),
        TENKACLOUD_SIMULATOR_HOST: "127.0.0.1",
        TENKACLOUD_SIMULATOR_PORT: new URL(intent.baseUrl).port,
        TENKACLOUD_SIMULATOR_LAUNCH_SECRET: intent.launchSecret,
        TENKACLOUD_SIMULATOR_STATE_DIR: intent.stateDir,
        ...nativeCredentialEnv(intent.nativeCredentials),
        ...workloadEnvironment(intent.workloadImages),
      },
    },
  );
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error("Simulator executable did not start");
  const registration = await waitForProcessRegistration(
    intent.registrationPath,
    child.pid,
    LAUNCH_REGISTRATION_TIMEOUT_MS,
    true,
  );
  const identity = registration
    ? processIdentityFromStartTime(registration.pid, registration.startTime)
    : undefined;
  if (!identity || observeProcessIdentity(child.pid) !== identity) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The process exited before its identity could be recorded.
    }
    throw new Error("Simulator process identity could not be recorded");
  }
  return {
    kind: "process",
    baseUrl: intent.baseUrl,
    launchSecret: intent.launchSecret,
    nativeCredentials: intent.nativeCredentials,
    pid: child.pid,
    processIdentity: identity,
    childPid: registration.childPid,
    childProcessIdentity:
      registration.childPid && registration.childStartTime
        ? processIdentityFromStartTime(registration.childPid, registration.childStartTime)
        : undefined,
    ownershipLeasePath: intent.ownershipLeasePath,
    registrationPath: intent.registrationPath,
    launchIntentPath: intent.launchIntentPath,
  };
}

function dockerCli(value: string | undefined): string {
  const cli = value?.trim() || "docker";
  if (/\s/.test(cli) || cli.includes("\0")) {
    throw new Error("TENKACLOUD_SIMULATOR_DOCKER_CLI must name one executable");
  }
  return cli;
}

function dockerSocket(value: string | undefined): string {
  const path = value?.trim() || DEFAULT_DOCKER_SOCKET;
  const segments = path.split("/");
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.includes(",") ||
    /[\r\n]/.test(path) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("TENKACLOUD_SIMULATOR_DOCKER_SOCKET must be a safe absolute UNIX path");
  }
  return path;
}

function dockerSocketGroup(cli: string, image: string, socket: string): string {
  const result = spawnSync(
    cli,
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${socket},dst=/var/run/docker.sock,readonly`,
      "--entrypoint",
      "/usr/bin/stat",
      image,
      "-c",
      "%g",
      "/var/run/docker.sock",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const group = result.stdout.trim();
  if (result.status !== 0 || !/^\d{1,10}$/.test(group)) {
    throw new Error(
      `Simulator workload Docker socket inspection failed: ${result.stderr.trim() || "invalid socket group"}`,
    );
  }
  return group;
}

function startContainer(
  intent: Extract<SimulatorOwnedLaunchIntent, { kind: "container" }>,
  env: NodeJS.ProcessEnv,
): SimulatorLauncherRecord {
  if (!IMAGE_DIGEST.test(intent.image)) {
    throw new Error(
      "TENKACLOUD_SIMULATOR_IMAGE must be digest-pinned as name@sha256:<64 lowercase hex>",
    );
  }
  const port = new URL(intent.baseUrl).port;
  const containerStateDir = "/var/lib/tenkacloud-simulator";
  const cli = dockerCli(env.TENKACLOUD_SIMULATOR_DOCKER_CLI);
  const workloadEnabled = intent.workloadImages.length > 0;
  const socket = workloadEnabled ? dockerSocket(env.TENKACLOUD_SIMULATOR_DOCKER_SOCKET) : undefined;
  const socketGroup =
    socket === undefined ? undefined : dockerSocketGroup(cli, intent.image, socket);
  const result = spawnSync(
    cli,
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      intent.containerName,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--memory=536870912",
      "--cpus=1",
      "--pids-limit=128",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16777216",
      "--publish",
      `127.0.0.1:${port}:${port}`,
      "--mount",
      `type=bind,src=${intent.stateDir},dst=${containerStateDir}`,
      ...(socket === undefined
        ? []
        : [
            "--mount",
            `type=bind,src=${socket},dst=/var/run/docker.sock,readonly`,
            "--group-add",
            socketGroup ?? "",
          ]),
      "--env",
      "TENKACLOUD_SIMULATOR_CONTAINER_MODE=1",
      "--env",
      "TENKACLOUD_SIMULATOR_HOST=0.0.0.0",
      "--env",
      `TENKACLOUD_SIMULATOR_PORT=${port}`,
      "--env",
      `TENKACLOUD_SIMULATOR_PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
      "--env",
      `TENKACLOUD_SIMULATOR_LAUNCH_SECRET=${intent.launchSecret}`,
      "--env",
      `TENKACLOUD_SIMULATOR_STATE_DIR=${containerStateDir}`,
      ...Object.entries(nativeCredentialEnv(intent.nativeCredentials)).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      ...Object.entries(
        workloadEnvironment(
          intent.workloadImages,
          workloadEnabled ? intent.containerName : undefined,
        ),
      ).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      intent.image,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`Simulator container failed to start: ${result.stderr.trim()}`);
  }
  return {
    kind: "container",
    baseUrl: intent.baseUrl,
    launchSecret: intent.launchSecret,
    nativeCredentials: intent.nativeCredentials,
    containerName: intent.containerName,
    launchIntentPath: intent.launchIntentPath,
  };
}

/** Resolve and fully describe a launch before any owned process/container starts. */
export async function prepareSimulatorLaunch(
  options: SimulatorLauncherOptions,
  sessionPath: string,
): Promise<SimulatorLaunchPreparation> {
  const env = options.env ?? process.env;
  const workloadImages = normalizedWorkloadImages(options.workloadImages);
  const source = resolveSimulatorSource(env);
  const stateDir = privateStateDir(options.stateDir);
  if (source.kind === "external") {
    const launchSecret = env.TENKACLOUD_SIMULATOR_LAUNCH_SECRET?.trim();
    if (!launchSecret) {
      throw new Error(
        "TENKACLOUD_SIMULATOR_LAUNCH_SECRET is required with TENKACLOUD_SIMULATOR_URL",
      );
    }
    decodeSimulatorLaunchSecret(launchSecret);
    return {
      kind: "external",
      launcher: {
        kind: "external",
        baseUrl: simulatorBaseUrl(source.url),
        launchSecret,
        nativeCredentials: externalNativeCredentials(env),
      },
    };
  }
  if (!isAbsolute(options.logPath)) throw new Error("Simulator log path must be absolute");
  const nativeCredentials = createNativeCredentials();
  const port = await freeLoopbackPort();
  const launchSecret = createSimulatorLaunchSecret();
  const intentId = randomUUID();
  const common = {
    version: LAUNCH_INTENT_VERSION,
    intentId,
    createdAtMs: Date.now(),
    baseUrl: `http://127.0.0.1:${port}`,
    launchSecret,
    nativeCredentials,
    stateDir,
    workloadImages,
    launchIntentPath: simulatorLaunchIntentPath(sessionPath),
  } as const;
  if (source.kind === "process") {
    assertExecutable(source.command);
    return {
      kind: "owned",
      intent: {
        ...common,
        kind: "process",
        command: source.command,
        args: commandArgs(env.TENKACLOUD_SIMULATOR_ARGS),
        logPath: options.logPath,
        registrationPath: expectedRegistrationPath(sessionPath, intentId),
        ownershipLeasePath: expectedOwnershipLeasePath(sessionPath, intentId),
      },
    };
  }
  if (!IMAGE_DIGEST.test(source.image)) {
    throw new Error(
      "TENKACLOUD_SIMULATOR_IMAGE must be digest-pinned as name@sha256:<64 lowercase hex>",
    );
  }
  return {
    kind: "owned",
    intent: {
      ...common,
      kind: "container",
      image: source.image,
      containerName: `tenkacloud-simulator-${intentId}`,
    },
  };
}

export async function launchPreparedSimulator(
  intent: SimulatorOwnedLaunchIntent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SimulatorLauncherRecord> {
  if (intent.kind === "container") return startContainer(intent, env);
  writePrivateText(intent.ownershipLeasePath, `${intent.intentId}\n`);
  return startProcess(intent, env);
}

function launcherMatchesIntent(
  launcher: SimulatorLauncherRecord,
  intent: SimulatorOwnedLaunchIntent,
): boolean {
  return (
    launcher.kind === intent.kind &&
    launcher.baseUrl === intent.baseUrl &&
    launcher.launchSecret === intent.launchSecret &&
    (intent.kind !== "container" || launcher.containerName === intent.containerName)
  );
}

/** Stop an unmatched prepared launch, or clear an intent already owned by the session record. */
export async function reconcileSimulatorLaunchIntent(
  sessionPath: string,
  committedLauncher: SimulatorLauncherRecord | undefined,
  env: NodeJS.ProcessEnv = process.env,
  registrationTimeoutMs = LAUNCH_REGISTRATION_TIMEOUT_MS,
): Promise<void> {
  const intent = readSimulatorLaunchIntent(sessionPath);
  if (!intent) return;
  if (committedLauncher && launcherMatchesIntent(committedLauncher, intent)) {
    clearSimulatorLaunchIntent(sessionPath);
    return;
  }
  if (intent.kind === "container") {
    await stopSimulatorLauncher(
      {
        kind: "container",
        baseUrl: intent.baseUrl,
        launchSecret: intent.launchSecret,
        nativeCredentials: intent.nativeCredentials,
        containerName: intent.containerName,
        launchIntentPath: intent.launchIntentPath,
      },
      env,
    );
    clearSimulatorLaunchIntent(sessionPath);
    return;
  }
  const registration = await waitForProcessRegistration(
    intent.registrationPath,
    undefined,
    registrationTimeoutMs,
  );
  if (registration) {
    await stopSimulatorLauncher(
      {
        kind: "process",
        baseUrl: intent.baseUrl,
        launchSecret: intent.launchSecret,
        nativeCredentials: intent.nativeCredentials,
        pid: registration.pid,
        processIdentity: processIdentityFromStartTime(registration.pid, registration.startTime),
        ...(registration.childPid && registration.childStartTime
          ? {
              childPid: registration.childPid,
              childProcessIdentity: processIdentityFromStartTime(
                registration.childPid,
                registration.childStartTime,
              ),
            }
          : {}),
        ownershipLeasePath: intent.ownershipLeasePath,
        registrationPath: intent.registrationPath,
        launchIntentPath: intent.launchIntentPath,
      },
      env,
    );
  } else {
    // Removing the precommitted lease is also the supervisor's cancellation
    // signal if it was scheduled but had not yet published its registration.
    releaseProcessLaunchFiles(intent);
  }
  // The wrapper's first operation is an atomic registration before exec. If no
  // registration appears within the bounded window, spawn was never reached or
  // the wrapper exited before it could own a Simulator process.
  clearSimulatorLaunchIntent(sessionPath);
}

/**
 * Resolve exactly one real Simulator boundary. Runtime ownership uses the
 * prepare/persist/start flow above; this convenience remains for isolated use.
 */
export async function launchSimulator(
  options: SimulatorLauncherOptions,
): Promise<SimulatorLauncherRecord> {
  const ownershipSessionPath =
    options.sessionPath ?? join(options.stateDir, "simulator-session.json");
  const prepared = await prepareSimulatorLaunch(options, ownershipSessionPath);
  if (prepared.kind === "external") return prepared.launcher;
  if (!options.sessionPath) {
    throw new Error("Owned Simulator launch requires a durable sessionPath");
  }
  writeSimulatorLaunchIntent(ownershipSessionPath, prepared.intent);
  try {
    return await launchPreparedSimulator(prepared.intent, options.env);
  } catch (error) {
    await reconcileSimulatorLaunchIntent(ownershipSessionPath, undefined, options.env);
    throw error;
  }
}

async function stopExactProcess(
  pid: number,
  expectedIdentity: string | undefined,
  timeoutMs: number,
  signal: NodeJS.Signals,
  label: string,
): Promise<void> {
  const currentIdentity = observeProcessIdentity(pid);
  if (currentIdentity === undefined) return;
  if (!expectedIdentity) {
    throw new Error(`${label} identity changed or is missing; refusing to signal the recorded PID`);
  }
  if (currentIdentity !== expectedIdentity) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = observeProcessIdentity(pid);
    if (observed === undefined || observed !== expectedIdentity) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (observeProcessIdentity(pid) === expectedIdentity) {
    throw new Error(`${label} did not stop within ${timeoutMs}ms`);
  }
}

async function stopProcessLauncher(
  launcher: SimulatorLauncherRecord,
  pid: number,
  timeoutMs: number,
  signal: NodeJS.Signals,
): Promise<void> {
  const errors: unknown[] = [];
  // Stop the supervised command first. On Linux /bin/sh may defer its trap
  // while it waits for that command, so waiting on the supervisor first can
  // consume the whole timeout even though both processes honor the signal.
  if (launcher.childPid !== undefined && launcher.childPid !== pid) {
    try {
      await stopExactProcess(
        launcher.childPid,
        launcher.childProcessIdentity,
        timeoutMs,
        signal,
        "Simulator child process",
      );
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await stopExactProcess(
      pid,
      launcher.processIdentity,
      timeoutMs,
      signal,
      "Simulator supervisor process",
    );
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Simulator process did not stop within ${timeoutMs}ms`);
  }
  releaseProcessLaunchFiles(launcher);
}

function stopContainerLauncher(
  launcher: SimulatorLauncherRecord,
  containerName: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): void {
  const stopGraceSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const commandTimeoutMs = Math.min(timeoutMs + 5_000, 2_147_483_647);
  const result = spawnSync(
    dockerCli(env.TENKACLOUD_SIMULATOR_DOCKER_CLI),
    ["stop", "--time", String(stopGraceSeconds), containerName],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: commandTimeoutMs },
  );
  if (result.status !== 0 && !result.stderr.includes("No such container")) {
    throw new Error(`Simulator container failed to stop: ${result.stderr.trim()}`);
  }
  if (launcher.launchIntentPath) unlinkIfExists(launcher.launchIntentPath);
}

export async function stopSimulatorLauncher(
  launcher: SimulatorLauncherRecord,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LAUNCHER_STOP_TIMEOUT_MS,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Simulator launcher stop timeout must be a positive safe integer");
  }
  if (launcher.kind === "process" && launcher.pid !== undefined) {
    await stopProcessLauncher(launcher, launcher.pid, timeoutMs, signal);
  }
  if (launcher.kind === "container" && launcher.containerName) {
    stopContainerLauncher(launcher, launcher.containerName, env, timeoutMs);
  }
}
