/**
 * [Issue #2909] Docker measurement primitives for the local-mode resource
 * profiles — parsing only, no Docker invocation.
 *
 * Every function here is pure so the interpretation of Docker's output can be
 * unit-tested without a daemon: the callers (`scripts/local/measure-profile.ts`,
 * `scripts/tenkacloud-onboard.ts`) inject the captured stdout.
 *
 * Two decisions are load-bearing and easy to get wrong:
 *
 *  1. `docker stats` prints `MemUsage` as `128.6MiB / 3.813GiB`. Only the LEFT
 *     side is this container's usage; the right side is the host/VM limit and is
 *     repeated identically on every row, so summing it multiplies the VM size by
 *     the container count. {@link parseDockerStats} drops the right side.
 *  2. Only TenkaCloud-owned containers are counted ({@link selectOwnContainers}).
 *     Counting whatever else the operator happens to be running would make a
 *     published requirement depend on the measurer's unrelated workload.
 *
 * "Not knowable" is always `undefined`, never a substituted zero — a value the
 * caller could not read must not become a number a requirement is derived from.
 */

/** The control-plane container (`compose.local.yaml`'s `container_name`). */
export const LOCAL_CONTROL_PLANE_CONTAINER = "tenkacloud-local";

/** Compose-project prefix of every per-problem container (`manifest.ts`). */
export const LOCAL_PROBLEM_PROJECT_PREFIX = "tc-local-";

export interface ContainerSample {
  readonly name: string;
  readonly cpuPercent: number;
  readonly memBytes: number;
}

/** `docker stats` field order this module parses. */
export const DOCKER_STATS_FORMAT = "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}";

/** `docker info` field order {@link parseDockerInfo} expects. */
export const DOCKER_INFO_FORMAT =
  "{{.NCPU}}\t{{.MemTotal}}\t{{.ServerVersion}}\t{{.OperatingSystem}}\t{{.Architecture}}";

const SIZE_UNITS: readonly (readonly [string, number])[] = [
  ["b", 1],
  ["kb", 1000],
  ["mb", 1000 ** 2],
  ["gb", 1000 ** 3],
  ["tb", 1000 ** 4],
  ["kib", 1024],
  ["mib", 1024 ** 2],
  ["gib", 1024 ** 3],
  ["tib", 1024 ** 4],
];

/**
 * Parse one Docker size literal (`128.6MiB`, `1.11MB`, `0B`) into bytes.
 * Docker mixes decimal (`MB`) and binary (`MiB`) units in the same output, so
 * both are handled with their true multipliers rather than being conflated.
 */
export function parseSize(text: string): number | undefined {
  // Written without an optional-then-required digit run (`\d*\.?\d+`), which is
  // ambiguous and backtracks: `\d+(?:\.\d+)?` matches Docker's output the same
  // way with a single deterministic path.
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "") return value;
  const found = SIZE_UNITS.find(([suffix]) => suffix === unit);
  return found ? value * found[1] : undefined;
}

function parsePercent(text: string): number {
  const value = Number.parseFloat(text.replace("%", "").trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse `docker stats --no-stream --format {@link DOCKER_STATS_FORMAT}`.
 * Rows that cannot be understood are skipped rather than defaulted, so a format
 * change surfaces as a missing container instead of a silent 0 MiB reading.
 */
export function parseDockerStats(text: string): ContainerSample[] {
  const samples: ContainerSample[] = [];
  for (const line of text.split("\n")) {
    const [name, cpu, mem] = line.split("\t");
    if (name === undefined || cpu === undefined || mem === undefined) continue;
    if (name.trim() === "") continue;
    // Left of the "/" only: the right side is the host/VM limit, identical on
    // every row (see the module comment).
    const used = mem.split("/")[0];
    if (used === undefined) continue;
    const memBytes = parseSize(used);
    if (memBytes === undefined) continue;
    samples.push({ name: name.trim(), cpuPercent: parsePercent(cpu), memBytes });
  }
  return samples;
}

/** Keep only containers this platform owns (control plane + `tc-local-*` problems). */
export function selectOwnContainers(samples: readonly ContainerSample[]): ContainerSample[] {
  return samples.filter(
    (sample) =>
      sample.name === LOCAL_CONTROL_PLANE_CONTAINER ||
      sample.name.startsWith(LOCAL_PROBLEM_PROJECT_PREFIX),
  );
}

export interface UsageSummary {
  readonly containerCount: number;
  readonly totalMemBytes: number;
  readonly totalCpuPercent: number;
  /** Sorted by descending memory so the dominant term is first. */
  readonly containers: readonly ContainerSample[];
}

/** Aggregate owned container samples into one profile observation. */
export function summarize(samples: readonly ContainerSample[]): UsageSummary {
  const containers = [...samples].sort((a, b) => b.memBytes - a.memBytes);
  return {
    containerCount: containers.length,
    totalMemBytes: containers.reduce((sum, c) => sum + c.memBytes, 0),
    totalCpuPercent: Number(containers.reduce((sum, c) => sum + c.cpuPercent, 0).toFixed(2)),
    containers,
  };
}

export interface DockerHostFacts {
  /** Logical CPUs available to the Docker daemon, `undefined` when unreadable. */
  readonly cpus?: number;
  /** Memory available to the Docker daemon in bytes, `undefined` when unreadable. */
  readonly memoryBytes?: number;
  readonly serverVersion?: string;
  readonly operatingSystem?: string;
  readonly architecture?: string;
}

function nonEmpty(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse `docker info --format {@link DOCKER_INFO_FORMAT}`.
 *
 * When the daemon is unreachable the Docker CLI still prints a fully-populated
 * template line (`0\t0\t\t\t`) and reports the failure only on stderr, so `0`
 * here means "not answered" and is mapped to `undefined`. Treating it as a real
 * zero would let a profile check "pass" against a daemon that is not running.
 */
export function parseDockerInfo(text: string): DockerHostFacts {
  const [cpus, memory, serverVersion, operatingSystem, architecture] = text
    .split("\n")[0]
    .split("\t");
  const cpuCount = Number.parseInt(cpus ?? "", 10);
  const memoryBytes = Number.parseInt(memory ?? "", 10);
  return {
    cpus: Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : undefined,
    memoryBytes: Number.isFinite(memoryBytes) && memoryBytes > 0 ? memoryBytes : undefined,
    serverVersion: nonEmpty(serverVersion),
    operatingSystem: nonEmpty(operatingSystem),
    architecture: nonEmpty(architecture),
  };
}

/**
 * Free bytes on the Docker VM's root filesystem, from `df -P /` run INSIDE a
 * container. The host's own free space is the wrong number on macOS/Windows,
 * where images and build cache live in a separate VM disk — that VM disk filling
 * up is the failure recorded on Issue #2909 (BuildKit aborting with
 * `rpc error: EOF`), and the host had tens of GB free at the time.
 *
 * `df -P` guarantees the POSIX column order and one row per filesystem, so the
 * 1024-byte "available" column is field 4.
 */
export function parseDiskAvailableBytes(dfStdout: string): number | undefined {
  for (const line of dfStdout.trim().split("\n")) {
    if (!/\s\/\s*$/.test(line)) continue; // the row whose mount point is "/"
    const available = line.trim().split(/\s+/)[3];
    const blocks = Number.parseInt(available ?? "", 10);
    if (Number.isFinite(blocks) && blocks >= 0) return blocks * 1024;
  }
  return undefined;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Render bytes for humans: `3.81 GiB`, `119 MiB`, `unknown` for `undefined`. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown";
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MiB`;
  return `${bytes} B`;
}
