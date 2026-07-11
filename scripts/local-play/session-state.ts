import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalComposeUnit } from "./container-runner";

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

export function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
}

export function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Idempotent: the process may already have exited.
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
  probe: (apiBaseUrl: string) => Promise<boolean>,
  release: (state: S) => void,
  fileExists: (path: string) => boolean = existsSync,
): Promise<void> {
  if (!fileExists(statePath)) return;
  const state = readState();
  if (await probe(state.apiBaseUrl)) {
    throw new Error("Local play is already running. Run `make local-down` first.");
  }
  console.log(
    "A previous local-play session did not shut down cleanly (stopped Codespace or reboot?) — reclaiming it.",
  );
  release(state);
}

/** Shared by `down` and the stale-session reclaim: kill the API and restore files. */
export function releaseSessionState(p: LocalPaths, state: LocalProcessState): void {
  stopPid(state.pid);
  unlinkIfExists(state.deploymentPath);
  restoreRuntimeConfig(p.runtimeConfigBackupPath, p.runtimeConfigPath, true);
  unlinkIfExists(p.statePath);
}
