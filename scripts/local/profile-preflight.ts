/**
 * [Issue #2909] Profile-aware resource preflight: compare what Docker actually
 * has against what a profile has been measured in, and say what to do next.
 *
 * Three verdicts, and the difference between the last two is the whole point:
 *
 *  - `pass`    — the value was read and is at or above a configuration this
 *                profile was observed running in.
 *  - `warn`    — the value was read and is below every configuration measured so
 *                far. That is "untested", not "too small"; nothing here has been
 *                shown to fail at that size, and the wording says so.
 *  - `unknown` — the value could not be read, or the profile has no measurement
 *                to compare against. Never silently upgraded to `pass`: a host
 *                whose Docker allocation cannot be queried has not been checked.
 *
 * Every non-`pass` item carries exactly one concrete next command.
 */

import { formatBytes } from "./docker-metrics";
import type { LocalProfile } from "./profiles";

export type PreflightStatus = "pass" | "warn" | "unknown";

export type PreflightItemId = "docker-cpus" | "docker-memory" | "free-disk";

export interface PreflightItem {
  readonly id: PreflightItemId;
  readonly title: string;
  readonly status: PreflightStatus;
  readonly detail: string;
  /** One command or setting change. Absent only when the item passed. */
  readonly nextAction?: string;
}

export interface PreflightFacts {
  readonly dockerCpus?: number;
  readonly dockerMemoryBytes?: number;
  readonly freeDiskBytes?: number;
}

export interface PreflightResult {
  readonly profile: LocalProfile;
  readonly items: readonly PreflightItem[];
  /** The worst item status: `warn` > `unknown` > `pass`. */
  readonly status: PreflightStatus;
}

const NO_MEASUREMENT_ACTION =
  "Measure it on this machine and contribute the record: `make local-measure PROFILE=<id>`";

const DOCKER_ALLOCATION_ACTION =
  "Raise the Docker allocation (Docker Desktop: Settings → Resources; colima: `colima stop && colima start --cpu <n> --memory <GiB>`)";

const DOCKER_UNREADABLE_ACTION =
  "Start the Docker daemon, then re-run `tenkacloud doctor` (`make doctor`)";

const DISK_ACTION =
  "Free space on the Docker VM disk: `docker builder prune -af && docker image prune -af`";

const DISK_UNREADABLE_ACTION =
  "Probe it directly: `docker run --rm busybox df -P /` (needs a reachable daemon)";

function cpuItem(profile: LocalProfile, facts: PreflightFacts): PreflightItem {
  const base = { id: "docker-cpus" as const, title: "Docker CPUs" };
  const verified = profile.requirements.verifiedConfiguration;
  if (facts.dockerCpus === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: "could not read the CPU count Docker has",
      nextAction: DOCKER_UNREADABLE_ACTION,
    };
  }
  if (verified === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: `${facts.dockerCpus} available; no measurement recorded for the "${profile.id}" profile yet`,
      nextAction: NO_MEASUREMENT_ACTION,
    };
  }
  const detail = `${facts.dockerCpus} available; measured working with ${verified.dockerCpus} (${verified.platformKey})`;
  if (facts.dockerCpus >= verified.dockerCpus) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: "warn",
    detail: `${detail} — fewer CPUs than any measured run, so this size is untested rather than known to fail`,
    nextAction: DOCKER_ALLOCATION_ACTION,
  };
}

function memoryItem(profile: LocalProfile, facts: PreflightFacts): PreflightItem {
  const base = { id: "docker-memory" as const, title: "Docker memory" };
  const verified = profile.requirements.verifiedConfiguration;
  if (facts.dockerMemoryBytes === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: "could not read the memory Docker has",
      nextAction: DOCKER_UNREADABLE_ACTION,
    };
  }
  const available = formatBytes(facts.dockerMemoryBytes);
  if (verified === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: `${available} available; no measurement recorded for the "${profile.id}" profile yet`,
      nextAction: NO_MEASUREMENT_ACTION,
    };
  }
  const detail =
    `${available} available; measured working with ${formatBytes(verified.dockerMemoryBytes)} ` +
    `while the containers themselves used ${formatBytes(verified.observedMemBytes)} (${verified.platformKey})`;
  if (facts.dockerMemoryBytes >= verified.dockerMemoryBytes) {
    return { ...base, status: "pass", detail };
  }
  return {
    ...base,
    status: "warn",
    detail: `${detail} — less memory than any measured run, so this size is untested rather than known to fail`,
    nextAction: DOCKER_ALLOCATION_ACTION,
  };
}

function diskItem(profile: LocalProfile, facts: PreflightFacts): PreflightItem {
  const base = { id: "free-disk" as const, title: "Docker VM free disk" };
  const floor = profile.requirements.diskFloor;
  if (facts.freeDiskBytes === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: "could not read free space on the Docker VM disk",
      nextAction: DISK_UNREADABLE_ACTION,
    };
  }
  const free = formatBytes(facts.freeDiskBytes);
  if (floor === undefined) {
    return {
      ...base,
      status: "unknown",
      detail: `${free} free; no image footprint recorded for the "${profile.id}" profile yet`,
      nextAction: NO_MEASUREMENT_ACTION,
    };
  }
  const detail = `${free} free; ${formatBytes(floor.bytes)} is ${floor.covers}`;
  if (facts.freeDiskBytes >= floor.bytes) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: "warn",
    detail: `${detail} — below the floor, so the image cannot finish materialising`,
    nextAction: DISK_ACTION,
  };
}

/** `warn` beats `unknown` beats `pass`. */
export function worstStatus(items: readonly PreflightItem[]): PreflightStatus {
  if (items.some((item) => item.status === "warn")) return "warn";
  if (items.some((item) => item.status === "unknown")) return "unknown";
  return "pass";
}

export function evaluateProfile(profile: LocalProfile, facts: PreflightFacts): PreflightResult {
  const items = [cpuItem(profile, facts), memoryItem(profile, facts), diskItem(profile, facts)];
  return { profile, items, status: worstStatus(items) };
}

const STATUS_ICON: Record<PreflightStatus, string> = { pass: "✓", warn: "!", unknown: "?" };

const STATUS_SUMMARY: Record<PreflightStatus, string> = {
  pass: "PASS — this machine is at or above every configuration this profile was measured in.",
  warn: "WARN — this machine is below every measured configuration. Untested, not known to fail.",
  unknown: "UNKNOWN — at least one value could not be read or has never been measured.",
};

/** The profile preflight block appended to the doctor report. */
export function formatPreflight(result: PreflightResult): string {
  const { profile } = result;
  const lines = [
    `Selected profile: ${profile.id} — ${profile.title} (${profile.status})`,
    `  Runs: ${profile.includes.join("; ")}`,
    `  Concurrent problems: ${profile.concurrentProblems}`,
  ];
  for (const item of result.items) {
    lines.push(`  ${STATUS_ICON[item.status]} ${item.title} — ${item.detail}`);
    if (item.nextAction) lines.push(`      Next: ${item.nextAction}`);
  }
  lines.push(`  Result: ${STATUS_SUMMARY[result.status]}`);
  if (profile.unverified.length > 0) {
    lines.push(`  Not measured yet: ${profile.unverified.join("; ")}`);
  }
  return lines.join("\n");
}
