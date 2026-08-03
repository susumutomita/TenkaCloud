import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalComposeUnit } from "./container-runner";
import { observeProcessIdentity } from "./process-identity";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * [#2527 Slice 6] Local-play session state, extracted verbatim from
 * `scripts/tenkacloud-local.ts`: the on-disk session layout (`.tenkacloud/local`),
 * the state/units record shapes, private-JSON persistence, runtime-config
 * backup/restore, and the stale-session reclaim used across `up` / `down` and a
 * crashed previous session. No docker or HTTP access — the entrypoint wires those.
 */

export interface LocalProcessState {
  readonly pid: number;
  /** Hash of the PID and OS-observed start time, used to reject PID reuse. */
  readonly processIdentity?: string;
  readonly apiBaseUrl: string;
  /** The pre-started problems (`PROBLEM=a,b,c`); the API serves the whole catalog. */
  readonly problemIds: readonly string[];
  readonly deploymentPath: string;
  readonly runtimeConfigPath: string;
  readonly runtimeConfigBackupPath?: string;
  readonly participantToken: string;
  /** Progress backend selected for this session; no credentials are persisted. */
  readonly databaseBackend?: "sqlite" | "turso";
}

/**
 * [#2392 Phase 2] `units.json` — the serve process's persisted mirror of its
 * running compose units. Containers are started INSIDE the detached serve
 * process, so `down` (a separate process) reads this file to know what to tear
 * down — even after a crash.
 */
export interface RecordedUnits {
  readonly units: readonly LocalComposeUnit[];
}

export interface LocalPaths {
  readonly localDir: string;
  readonly statePath: string;
  readonly deploymentPath: string;
  readonly unitsPath: string;
  readonly runtimeConfigBackupPath: string;
  readonly logPath: string;
  readonly simulatorSessionPath: string;
  readonly simulatorStateDir: string;
  readonly simulatorLogPath: string;
  readonly simulatorEnvPath: string;
  readonly databasePath: string;
  readonly runtimeConfigPath: string;
}

export function resolveLocalPaths(): LocalPaths {
  const localDir = process.env.TENKACLOUD_LOCAL_DIR ?? join(REPO_ROOT, ".tenkacloud", "local");
  return {
    localDir,
    statePath: join(localDir, "state.json"),
    deploymentPath: join(localDir, "deployment.json"),
    unitsPath: join(localDir, "units.json"),
    runtimeConfigBackupPath: join(localDir, "runtime-config.backup.json"),
    logPath: join(localDir, "api.log"),
    simulatorSessionPath: join(localDir, "simulator-session.json"),
    simulatorStateDir: join(localDir, "simulator-state"),
    simulatorLogPath: join(localDir, "simulator.log"),
    simulatorEnvPath: join(localDir, "simulator-native.env"),
    databasePath: join(localDir, "local-play.sqlite"),
    runtimeConfigPath: join(
      REPO_ROOT,
      "apps",
      "participant-portal",
      "public",
      "runtime-config.json",
    ),
  };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readPrivateJson<T>(path: string, maxBytes = 16 * 1024 * 1024): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Private JSON is not a regular file: ${path}`);
    const size = stats.size;
    if (size > maxBytes) throw new Error(`Private JSON exceeds ${maxBytes} bytes: ${path}`);
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally {
    closeSync(fd);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port.length > 0 &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

/** Read and validate the bearer-bearing detached-process state without following symlinks. */
export function readLocalProcessState(path: string, paths: LocalPaths): LocalProcessState {
  const value = record(readPrivateJson<unknown>(path, 64 * 1024), "Local process state");
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
    throw new Error("Local process state has an invalid pid");
  }
  if (typeof value.processIdentity !== "string" || !/^[a-f0-9]{64}$/.test(value.processIdentity)) {
    throw new Error("Local process state has an invalid process identity");
  }
  if (!exactLoopbackOrigin(value.apiBaseUrl)) {
    throw new Error("Local process state has a non-loopback Participant API origin");
  }
  if (
    value.deploymentPath !== paths.deploymentPath ||
    value.runtimeConfigPath !== paths.runtimeConfigPath ||
    (value.runtimeConfigBackupPath !== undefined &&
      value.runtimeConfigBackupPath !== paths.runtimeConfigBackupPath)
  ) {
    throw new Error("Local process state contains an unexpected owned path");
  }
  if (
    !Array.isArray(value.problemIds) ||
    value.problemIds.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("Local process state has invalid problem IDs");
  }
  if (
    typeof value.participantToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.participantToken)
  ) {
    throw new Error("Local process state has an invalid participant token");
  }
  if (
    value.databaseBackend !== undefined &&
    value.databaseBackend !== "sqlite" &&
    value.databaseBackend !== "turso"
  ) {
    throw new Error("Local process state has an invalid database backend");
  }
  return value as unknown as LocalProcessState;
}

function pathWithin(path: string, root: string): boolean {
  const absolute = resolve(path);
  const absoluteRoot = resolve(root);
  return absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${sep}`);
}

function assertRecordedUnitShape(unit: Record<string, unknown>): void {
  if (
    typeof unit.problemId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(unit.problemId) ||
    typeof unit.composePath !== "string" ||
    !isAbsolute(unit.composePath) ||
    typeof unit.composeProjectName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(unit.composeProjectName) ||
    !Array.isArray(unit.secretEnv)
  ) {
    throw new Error("Recorded compose unit is invalid");
  }
  if (unit.secretEnv.some((name) => typeof name !== "string" || !/^[A-Za-z_]\w*$/.test(name))) {
    throw new Error("Recorded compose unit is invalid");
  }
}

function assertRecordedProjectDirectory(unit: Record<string, unknown>): void {
  if (
    unit.projectDirectory !== undefined &&
    (typeof unit.projectDirectory !== "string" ||
      !isAbsolute(unit.projectDirectory) ||
      !pathWithin(unit.projectDirectory, REPO_ROOT))
  ) {
    throw new Error("Recorded compose project directory is outside the repository");
  }
}

function assertRecordedComposePath(unit: Record<string, unknown>, localDir: string): void {
  if (unit.remappedComposePath === undefined) {
    if (!pathWithin(String(unit.composePath), REPO_ROOT)) {
      throw new Error("Recorded compose path is outside the repository");
    }
    return;
  }
  if (
    typeof unit.remappedComposePath !== "string" ||
    !isAbsolute(unit.remappedComposePath) ||
    !pathWithin(unit.remappedComposePath, localDir) ||
    resolve(String(unit.composePath)) !== resolve(unit.remappedComposePath) ||
    (existsSync(unit.remappedComposePath) && lstatSync(unit.remappedComposePath).isSymbolicLink())
  ) {
    throw new Error("Recorded remapped compose path is outside local state");
  }
}

function recordedComposeUnit(item: unknown, localDir: string): LocalComposeUnit {
  const unit = record(item, "Recorded compose unit");
  assertRecordedUnitShape(unit);
  assertRecordedProjectDirectory(unit);
  assertRecordedComposePath(unit, localDir);
  return unit as unknown as LocalComposeUnit;
}

/** Validate persisted compose ownership before invoking Docker or deleting a temp file. */
export function readRecordedUnits(path: string, localDir: string): RecordedUnits {
  const value = record(readPrivateJson<unknown>(path, 1024 * 1024), "Recorded units");
  if (!Array.isArray(value.units)) throw new Error("Recorded units must contain an array");
  const units = value.units.map((item) => recordedComposeUnit(item, localDir));
  if (new Set(units.map((unit) => unit.problemId)).size !== units.length) {
    throw new Error("Recorded compose problem IDs must be unique");
  }
  return { units };
}

export function writePrivateJson(path: string, value: unknown): void {
  writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePrivateText(path: string, value: string): void {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Preserve the former O_NOFOLLOW contract. This local same-user state has
    // no hostile directory writer, so a pre-rename lstat is sufficient here.
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link private state: ${path}`);
    }
    renameSync(temporary, path);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkIfExists(temporary);
  }
}

/** Signal only the exact serve process recorded by the owning `up` command. */
export function stopRecordedServeProcess(state: LocalProcessState): void {
  stopRecordedProcess(state.pid, state.processIdentity, "Local-play serve");
}

export function stopRecordedProcess(
  pid: number,
  expectedIdentity: string | undefined,
  _label: string,
): void {
  const currentIdentity = observeProcessIdentity(pid);
  if (currentIdentity === undefined) return;
  if (!expectedIdentity || currentIdentity !== expectedIdentity) {
    // The recorded process is already gone and the numeric PID belongs to a
    // replacement. Never signal it; continue cleanup of the stale ownership.
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    // The identity check and signal are necessarily separate syscalls. Natural
    // exit in that gap is an idempotent success; every other signal error is real.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

export function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Restore the participant-portal runtime-config from its backup. When a backup
 * exists it holds the developer's original config — copy it back and drop the
 * backup. Otherwise, remove the local config we wrote (`removeIfNoBackup`) or
 * leave the file alone when we can't tell whether it is ours.
 */
export function restoreRuntimeConfig(
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
 * A Codespace suspend / machine reboot kills the detached API process but
 * leaves state.json behind, so the next `make local` used to dead-end with
 * "already running. Run `make local-down` first" on every resume. Probe the
 * recorded API instead of trusting the file: alive → a real double-start
 * (keep refusing); dead → reclaim the stale session like `down` would and let
 * this start proceed.
 */
export async function reclaimStaleSession<S extends { apiBaseUrl: string }>(
  statePath: string,
  readState: () => S,
  probe: (state: S) => Promise<boolean>,
  release: (state: S) => void | Promise<void>,
  fileExists: (path: string) => boolean = existsSync,
): Promise<void> {
  if (!fileExists(statePath)) return;
  const state = readState();
  if (await probe(state)) {
    throw new Error("Local play is already running. Run `make local-down` first.");
  }
  console.log(
    "A previous local-play session did not shut down cleanly (stopped Codespace or reboot?) — reclaiming it.",
  );
  await release(state);
}

/** Restore session-owned files after the caller has signalled and reaped the API exactly once. */
export function releaseSessionState(p: LocalPaths, state: LocalProcessState): void {
  unlinkIfExists(state.deploymentPath);
  restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
  unlinkIfExists(p.statePath);
}
