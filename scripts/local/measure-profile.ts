#!/usr/bin/env bun
/**
 * [Issue #2909] `make local-measure` — measure what a local-mode profile actually
 * costs on THIS machine and write a machine-readable record.
 *
 * The published requirements table must be reproducible rather than an
 * impression, so this script re-runs the same scenario anywhere:
 *
 *   1. read the host facts Docker reports (CPUs, memory, VM free disk)
 *   2. sample the control plane alone (baseline)
 *   3. start the profile's problems one at a time, timing each start
 *   4. sample steady state with them all running
 *   5. stop them and assert the owned containers are reclaimed
 *   6. record the control-plane image size
 *   7. validate against {@link MeasurementRecordSchema} and write JSON
 *
 * Only TenkaCloud-owned containers are counted (`docker-metrics.ts`), so a
 * developer's unrelated containers cannot inflate a published number.
 *
 * The decision logic is pure and unit-tested; `main()` is the only part that
 * touches Docker, and it composes those functions with an injected runner.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProblemViaApi, waitForProblemRunning } from "../local-play/local-runtime-support";
import {
  type ContainerSample,
  DOCKER_INFO_FORMAT,
  DOCKER_STATS_FORMAT,
  type DockerHostFacts,
  formatBytes,
  LOCAL_CONTROL_PLANE_CONTAINER,
  parseDiskAvailableBytes,
  parseDockerInfo,
  parseDockerStats,
  parseSize,
  selectOwnContainers,
  summarize,
} from "./docker-metrics";
import {
  MEASUREMENT_SCHEMA_VERSION,
  type MeasurementRecord,
  parseMeasurementRecord,
} from "./measurement-report";
import { DEFAULT_PROFILE_ID, findProfile, isProfileId, type LocalProfile } from "./profiles";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORDS_DIR = resolve(REPO_ROOT, "docs", "measurements", "local-mode");
const CONTROL_PLANE_IMAGE = "tenkacloud-local:dev";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:5175";

export interface CommandOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MeasureRunner {
  run(command: string, args: readonly string[]): CommandOutcome;
}

/**
 * Which platform bucket the requirements table should file this run under.
 * Codespaces and WSL2 are checked before the plain OS, because both report
 * themselves as Linux while behaving differently enough to publish separately.
 */
export function resolvePlatformKey(
  hostPlatform: string,
  architecture: string | undefined,
  env: Record<string, string | undefined>,
): MeasurementRecord["platformKey"] {
  if (env.CODESPACES === "true" || env.CODESPACE_NAME) return "codespaces";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl2";
  const arm = architecture === "aarch64" || architecture === "arm64";
  if (hostPlatform === "darwin") return arm ? "macos-arm64" : "macos-x86_64";
  return "linux-x86_64";
}

/** `<date>-<platform>-<release>`, stable enough for a profile to cite. */
export function buildRecordId(capturedAt: string, platformKey: string, release: string): string {
  const day = capturedAt.slice(0, 10);
  return `${day}-${platformKey}-${release}`.replace(/[^A-Za-z0-9.-]+/g, "-").toLowerCase();
}

export interface ScenarioSample {
  readonly scenario: string;
  readonly profileId: MeasurementRecord["observations"][number]["profileId"];
  readonly samples: readonly ContainerSample[];
}

export interface RecordInput {
  readonly capturedAt: string;
  readonly release: string;
  readonly platformKey: MeasurementRecord["platformKey"];
  readonly facts: DockerHostFacts;
  readonly composeVersion: string | undefined;
  readonly hostDescription: string | undefined;
  readonly freeDiskBytes: number | undefined;
  readonly scenarios: readonly ScenarioSample[];
  readonly timings: MeasurementRecord["timings"];
  readonly controlPlaneImageBytes: number | undefined;
  readonly unmeasured: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Assemble the record. Pure: everything unreadable arrives as `undefined` and is
 * written as `null`, so a value the run could not obtain never becomes a `0` that
 * a later requirement could be derived from.
 */
export function buildRecord(input: RecordInput): MeasurementRecord {
  const record = {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    recordId: buildRecordId(input.capturedAt, input.platformKey, input.release),
    capturedAt: input.capturedAt,
    capturedBy: "measure-profile" as const,
    platformKey: input.platformKey,
    release: input.release,
    host: {
      cpus: input.facts.cpus ?? null,
      memoryBytes: input.facts.memoryBytes ?? null,
      freeDiskBytes: input.freeDiskBytes ?? null,
      serverVersion: input.facts.serverVersion ?? null,
      composeVersion: input.composeVersion ?? null,
      operatingSystem: input.facts.operatingSystem ?? null,
      architecture: input.facts.architecture ?? null,
      description: input.hostDescription ?? null,
    },
    observations: input.scenarios.map((scenario) => {
      const usage = summarize(scenario.samples);
      return {
        scenario: scenario.scenario,
        profileId: scenario.profileId,
        containerCount: usage.containerCount,
        totalMemBytes: Math.round(usage.totalMemBytes),
        totalCpuPercent: usage.totalCpuPercent,
        containers: usage.containers.map((container) => ({
          name: container.name,
          memBytes: Math.round(container.memBytes),
          cpuPercent: container.cpuPercent,
        })),
      };
    }),
    timings: input.timings,
    images:
      input.controlPlaneImageBytes === undefined
        ? []
        : [{ reference: CONTROL_PLANE_IMAGE, sizeBytes: input.controlPlaneImageBytes }],
    unmeasured: [...input.unmeasured],
    notes: [...input.notes],
  };
  // Validate before returning so a shape regression fails here rather than
  // producing a record CI will later reject.
  return parseMeasurementRecord(record);
}

/**
 * Owned containers left behind after the run stopped everything it started.
 * A non-empty result is a resource-reclaim failure worth reporting, not a
 * measurement to publish.
 */
export function leakedContainers(
  before: readonly ContainerSample[],
  after: readonly ContainerSample[],
): readonly string[] {
  const known = new Set(before.map((sample) => sample.name));
  return after.map((sample) => sample.name).filter((name) => !known.has(name));
}

/**
 * Problem containers that were already up before the run started. The baseline
 * is supposed to be the control plane alone, so anything else here would be
 * counted into the profile's steady state and published as part of its cost.
 */
export function preexistingProblemContainers(
  baseline: readonly ContainerSample[],
): readonly string[] {
  return baseline
    .map((sample) => sample.name)
    .filter((name) => name !== LOCAL_CONTROL_PLANE_CONTAINER);
}

const systemRunner: MeasureRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

function sampleOwnContainers(runner: MeasureRunner): ContainerSample[] {
  const stats = runner.run("docker", ["stats", "--no-stream", "--format", DOCKER_STATS_FORMAT]);
  return selectOwnContainers(parseDockerStats(stats.stdout));
}

function readHostFacts(runner: MeasureRunner): DockerHostFacts {
  return parseDockerInfo(runner.run("docker", ["info", "--format", DOCKER_INFO_FORMAT]).stdout);
}

/**
 * Free space on the Docker VM disk, probed from inside a container — on
 * macOS/Windows the host's own free space is a different filesystem entirely.
 * Returns `undefined` (never a guess) when the probe cannot run.
 */
function readFreeDiskBytes(runner: MeasureRunner): number | undefined {
  const probe = runner.run("docker", ["run", "--rm", "busybox", "df", "-P", "/"]);
  return probe.status === 0 ? parseDiskAvailableBytes(probe.stdout) : undefined;
}

function readComposeVersion(runner: MeasureRunner): string | undefined {
  const out = runner.run("docker", ["compose", "version", "--short"]);
  const version = out.stdout.trim();
  return out.status === 0 && version !== "" ? version : undefined;
}

function readImageBytes(runner: MeasureRunner, reference: string): number | undefined {
  const out = runner.run("docker", ["image", "inspect", reference, "--format", "{{.Size}}"]);
  if (out.status !== 0) return undefined;
  const bytes = parseSize(out.stdout.trim());
  return bytes === undefined ? undefined : Math.round(bytes);
}

interface ProblemStartResult {
  readonly problemId: string;
  readonly durationMs: number;
}

async function startAndTime(
  apiBaseUrl: string,
  token: string,
  problemId: string,
  log: (message: string) => void,
): Promise<ProblemStartResult> {
  const startedAt = Date.now();
  log(`→ starting ${problemId} …`);
  await startProblemViaApi(apiBaseUrl, problemId, token);
  await waitForProblemRunning(apiBaseUrl, problemId, token);
  const durationMs = Date.now() - startedAt;
  log(`✔ ${problemId} running in ${(durationMs / 1000).toFixed(1)}s`);
  return { problemId, durationMs };
}

async function stopProblem(apiBaseUrl: string, token: string, problemId: string): Promise<void> {
  const response = await fetch(
    `${apiBaseUrl}/portal/me/problems/${encodeURIComponent(problemId)}/stop`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`failed to stop "${problemId}" (HTTP ${response.status})`);
  }
}

/** The unauthenticated bootstrap route the Portal itself uses on a fresh load. */
async function readParticipantToken(apiBaseUrl: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/runtime-config.json`);
  if (!response.ok) {
    throw new Error(
      `local play is not answering on ${apiBaseUrl} (HTTP ${response.status}). Start it with \`make local\` first.`,
    );
  }
  const body = (await response.json()) as { localTeamLoginKey?: string };
  if (!body.localTeamLoginKey) {
    throw new Error(`${apiBaseUrl}/runtime-config.json did not include a participant token`);
  }
  return body.localTeamLoginKey;
}

/**
 * The problem ids to measure. The count must match the profile's concurrency:
 * measuring two problems and filing it under a three-problem profile would
 * publish a number for a scenario that was never run.
 */
export function requireProblemIds(
  profile: LocalProfile,
  raw: string | undefined,
): readonly string[] {
  const ids = (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) {
    throw new Error(
      `PROBLEMS is required: pass the problem ids to measure, e.g. ` +
        `\`make local-measure PROFILE=${profile.id} PROBLEMS=sqli-demo\`. ` +
        `List available ids with \`make local-list\`.`,
    );
  }
  if (ids.length !== profile.concurrentProblems) {
    throw new Error(
      `profile "${profile.id}" runs ${profile.concurrentProblems} problem(s) but ${ids.length} were given — ` +
        "measuring a different count would publish a number the profile does not describe.",
    );
  }
  return ids;
}

interface MeasureOptions {
  readonly profile: LocalProfile;
  readonly problemIds: readonly string[];
  readonly apiBaseUrl: string;
  readonly release: string;
  readonly phase: "cold" | "warm";
  readonly hostDescription: string | undefined;
}

async function measure(
  runner: MeasureRunner,
  options: MeasureOptions,
  log: (message: string) => void,
): Promise<MeasurementRecord> {
  const facts = readHostFacts(runner);
  if (facts.cpus === undefined) {
    throw new Error("`docker info` did not answer — start the Docker daemon and retry.");
  }
  const token = await readParticipantToken(options.apiBaseUrl);

  const baseline = sampleOwnContainers(runner);
  const preexisting = preexistingProblemContainers(baseline);
  if (preexisting.length > 0) {
    throw new Error(
      `problem containers are already running: ${preexisting.join(", ")} — their memory would be ` +
        `counted into the "${options.profile.id}" profile. Stop them, then re-run.`,
    );
  }
  log(
    `baseline: ${baseline.length} container(s), ${formatBytes(summarize(baseline).totalMemBytes)}`,
  );

  const timings: MeasurementRecord["timings"] = [];
  for (const problemId of options.problemIds) {
    const started = await startAndTime(options.apiBaseUrl, token, problemId, log);
    timings.push({
      id: `start:${problemId}`,
      phase: options.phase,
      durationMs: started.durationMs,
    });
  }

  const steady = sampleOwnContainers(runner);
  log(
    `steady state: ${steady.length} container(s), ${formatBytes(summarize(steady).totalMemBytes)}`,
  );

  for (const problemId of options.problemIds) {
    await stopProblem(options.apiBaseUrl, token, problemId);
  }
  const afterStop = sampleOwnContainers(runner);
  const leaked = leakedContainers(baseline, afterStop);
  if (leaked.length > 0) {
    throw new Error(
      `containers were not reclaimed after stop: ${leaked.join(", ")} — ` +
        "the run is not a valid steady-state measurement. Clean up with `make local-down`.",
    );
  }

  return buildRecord({
    capturedAt: new Date().toISOString(),
    release: options.release,
    platformKey: resolvePlatformKey(process.platform, facts.architecture, process.env),
    facts,
    composeVersion: readComposeVersion(runner),
    hostDescription: options.hostDescription,
    freeDiskBytes: readFreeDiskBytes(runner),
    scenarios: [
      { scenario: "control-plane-only", profileId: null, samples: baseline },
      {
        scenario: `${options.profile.id}: ${options.problemIds.join(" + ")}`,
        profileId: options.profile.id,
        samples: steady,
      },
      { scenario: "after-stop", profileId: null, samples: afterStop },
    ],
    timings,
    controlPlaneImageBytes: readImageBytes(runner, CONTROL_PLANE_IMAGE),
    unmeasured: [...options.profile.unverified],
    notes: [
      `Problems measured: ${options.problemIds.join(", ")} — other problems have different footprints.`,
      `Start timings recorded as "${options.phase}" (declared with PHASE=cold|warm, not detected).`,
    ],
  });
}

/**
 * `make` passes every unset variable through as an empty string, so `??` alone
 * would turn `make local-measure` (no PROFILE) into profile `""`.
 */
export function envValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

async function main(): Promise<void> {
  const profileId = envValue(process.env.PROFILE) ?? DEFAULT_PROFILE_ID;
  if (!isProfileId(profileId)) {
    throw new Error(`Unknown profile "${profileId}" (expected minimum, recommended, or full).`);
  }
  const profile = findProfile(profileId);
  if (!profile || profile.status === "planned") {
    throw new Error(
      `Profile "${profileId}" is not runnable end to end yet, so measuring it would record a ` +
        "partial run as if it were the whole profile.",
    );
  }
  const phase = envValue(process.env.PHASE) === "cold" ? "cold" : "warm";
  const record = await measure(
    systemRunner,
    {
      profile,
      problemIds: requireProblemIds(profile, envValue(process.env.PROBLEMS)),
      apiBaseUrl: envValue(process.env.LOCAL_API_BASE_URL) ?? DEFAULT_API_BASE_URL,
      release: envValue(process.env.RELEASE) ?? "unreleased",
      phase,
      hostDescription: envValue(process.env.HOST_DESCRIPTION),
    },
    (message) => console.log(message),
  );
  const outPath = envValue(process.env.OUT) ?? resolve(RECORDS_DIR, `${record.recordId}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(
    "Numbers published in docs/local-play-requirements.md must cite this record's id: " +
      record.recordId,
  );
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
