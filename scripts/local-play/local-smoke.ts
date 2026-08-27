/**
 * `make local-smoke PROBLEM=<id>` — start one local-play problem, assert it comes
 * up healthy (with at least one genuinely-running service), then tear it down.
 *
 * The point is a pre-commit / CI safety net for the failure the portal reports as
 * a bare 502 `start_failed`: a problem whose containers do not come up (broken
 * compose, wrong image, an unhealthy service, or — the common operational one —
 * a full Docker VM disk that aborts DB init with "No space left on device").
 *
 * The Docker-driving `main()` is composed only at the entrypoint. All decision
 * logic (health classification, disk-usage parsing, failure diagnosis, the
 * orchestration loop) is pure and takes injected command deps, so it is unit
 * tested with no Docker.
 */
import { spawnSync } from "node:child_process";
import {
  LONG_RUNNING_INSPECT_FORMAT,
  type ComposeService,
  classifyService,
  describeFailure,
  evaluateHealth,
  looksDiskFull,
  parseComposePs,
  parseLongRunning,
} from "./compose-health";
import { resolveComposeCli } from "./docker-adapter";

export {
  type ComposeService,
  classifyService,
  describeFailure,
  evaluateHealth,
  looksDiskFull,
  parseComposePs,
  parseLongRunning,
};

/** Extract the root filesystem use-percentage from `df -P /` output. */
export function parseDiskUsePercent(dfStdout: string): number | null {
  const lines = dfStdout.trim().split("\n");
  for (const line of lines) {
    if (!/\s\/\s*$/.test(line)) continue;
    const match = /(?<!\d)(\d+)%/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

export interface SmokeDeps {
  /** Run a command to completion, capturing status + output. */
  run(cmd: string, args: readonly string[]): { status: number; stdout: string; stderr: string };
  /** The resolved Docker Compose command — `docker compose` plugin or standalone `docker-compose`. */
  readonly composeCli: { readonly command: string; readonly prefix: readonly string[] };
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  now(): number;
}

export interface SmokeOptions {
  /** Fail preflight when the Docker VM disk is at/above this use-percent. */
  readonly diskThresholdPercent: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

const DOCKER = "docker";

/** Run a Docker Compose subcommand through the resolved CLI (plugin or standalone). */
function compose(
  deps: SmokeDeps,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  return deps.run(deps.composeCli.command, [...deps.composeCli.prefix, ...args]);
}

/** Dump the tail of each candidate container's logs and flag a full-disk signature. */
function diagnose(deps: SmokeDeps, project: string, candidates: readonly ComposeService[]): void {
  const targets =
    candidates.length > 0
      ? candidates
      : parseComposePs(compose(deps, ["-p", project, "ps", "-a", "--format", "json"]).stdout);
  let diskFull = false;
  for (const service of targets) {
    const logs = deps.run(DOCKER, ["logs", "--tail", "40", service.name]);
    const combined = `${logs.stdout}\n${logs.stderr}`;
    const tail = combined.trim().split("\n").slice(-20).join("\n");
    deps.log(`--- logs: ${service.service} (${service.name}) ---\n${tail}`);
    if (looksDiskFull(combined)) diskFull = true;
  }
  if (diskFull) {
    deps.log(
      '\n⚠ Detected "No space left on device": the Docker VM disk is full — this is why the container aborted.',
    );
    deps.log(
      "  Reclaim space (frees the colima VM disk): docker builder prune -af && docker image prune -af",
    );
  }
}

/** Docker reachable + VM disk not full. Returns false to abort the smoke run. */
function preflight(deps: SmokeDeps, options: SmokeOptions): boolean {
  if (deps.run(DOCKER, ["info"]).status !== 0) {
    deps.log(
      "✖ Docker daemon is not reachable. Start it (e.g. `colima start`) — see `make doctor`.",
    );
    return false;
  }
  const disk = deps.run(DOCKER, ["run", "--rm", "busybox", "df", "-P", "/"]);
  if (disk.status !== 0) {
    deps.log(
      "⚠ Could not measure Docker VM disk; continuing (a full disk would be reported below).",
    );
    return true;
  }
  const percent = parseDiskUsePercent(disk.stdout);
  if (percent !== null && percent >= options.diskThresholdPercent) {
    deps.log(
      `✖ Docker VM disk is ${percent}% full (>= ${options.diskThresholdPercent}%). Containers will fail with "No space left on device".`,
    );
    deps.log("  Reclaim space: docker builder prune -af && docker image prune -af");
    return false;
  }
  deps.log(`Docker VM disk: ${percent ?? "?"}% used — ok.`);
  return true;
}

/**
 * Names of exited services that were meant to stay up. Only exited services need
 * the check (dead already fails; running/pending do not depend on it), and the
 * healthcheck/ports config persists after exit, so a server that died cleanly is
 * still recognised as long-running.
 */
function longRunningServices(deps: SmokeDeps, services: readonly ComposeService[]): Set<string> {
  const names = new Set<string>();
  for (const service of services) {
    if (service.state !== "exited") continue;
    const inspected = deps.run(DOCKER, [
      "inspect",
      service.name,
      "--format",
      LONG_RUNNING_INSPECT_FORMAT,
    ]);
    // Fail closed: if `docker inspect` fails we cannot prove this exited service
    // was a permitted one-shot, so treat it as long-running (a failure) rather
    // than letting a clean exit slip through as a false pass.
    if (inspected.status !== 0 || parseLongRunning(inspected.stdout)) names.add(service.name);
  }
  return names;
}

type PollOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failing: readonly ComposeService[] };

/** Poll compose health until it settles healthy, a service fails, or the timeout elapses. */
async function pollHealth(
  deps: SmokeDeps,
  project: string,
  options: SmokeOptions,
): Promise<PollOutcome> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    // `-a` is required: `docker compose ps` without it lists only running
    // containers, so a crashed/exited service (e.g. a DB whose init aborted)
    // would be invisible and the smoke run would falsely pass.
    const services = parseComposePs(
      compose(deps, ["-p", project, "ps", "-a", "--format", "json"]).stdout,
    );
    const longRunning = longRunningServices(deps, services);
    const report = evaluateHealth(services, (service) => longRunning.has(service.name));
    if (services.length > 0 && report.done) {
      if (report.ok) {
        deps.log(
          `✔ ${report.running.length} running + ${services.length} total container(s) healthy.`,
        );
        return { ok: true };
      }
      return { ok: false, failing: report.failing };
    }
    if (deps.now() >= deadline) {
      deps.log(`✖ Timed out (${options.timeoutMs}ms) waiting for containers to become healthy.`);
      return { ok: false, failing: [] };
    }
    await deps.sleep(options.pollMs);
  }
}

/** Run the smoke check; returns a process exit code (0 = healthy). Always tears down. */
export async function runSmoke(
  deps: SmokeDeps,
  problemId: string,
  options: SmokeOptions,
): Promise<number> {
  if (!preflight(deps, options)) return 1;
  const project = `tc-local-${problemId}`;
  deps.run("make", ["local-down"]); // reclaim any prior session
  deps.log(`Starting problem "${problemId}" ...`);
  const up = deps.run("make", ["local-up", `PROBLEM=${problemId}`]);
  try {
    if (up.status !== 0) {
      deps.log(`✖ Problem "${problemId}" failed to start:\n${(up.stderr || up.stdout).trim()}`);
      diagnose(deps, project, []);
      return 1;
    }
    const outcome = await pollHealth(deps, project, options);
    if (outcome.ok) return 0;
    if (outcome.failing.length > 0) {
      deps.log(
        `✖ Container(s) failed for "${problemId}": ${outcome.failing.map(describeFailure).join(", ")}`,
      );
    } else {
      deps.log(`✖ No container stayed running for "${problemId}" (all exited, or it timed out).`);
    }
    diagnose(deps, project, outcome.failing);
    return 1;
  } finally {
    deps.log(`Tearing down "${problemId}" ...`);
    deps.run("make", ["local-down"]);
    // `make local-down` only reclaims *recorded* units; a problem whose compose
    // partially started before `up` failed leaves orphaned containers it never
    // recorded. Tear the project down by name too so a failed smoke run never
    // leaks partial startups.
    compose(deps, ["-p", project, "down", "-v", "--remove-orphans"]);
  }
}

/* v8 ignore start -- entrypoint glue: real Docker/process wiring, exercised by `make local-smoke`. */
function realDeps(composeCli: SmokeDeps["composeCli"]): SmokeDeps {
  return {
    run: (cmd, args) => {
      const result = spawnSync(cmd, [...args], { encoding: "utf8" });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    composeCli,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    log: (message) => console.log(message),
    now: () => Date.now(),
  };
}

async function main(): Promise<void> {
  const problemId = process.env.PROBLEM?.trim() || process.argv[2]?.trim() || "sqli-demo";
  let composeCli: SmokeDeps["composeCli"];
  try {
    const resolved = resolveComposeCli();
    composeCli = { command: resolved.command, prefix: resolved.prefix };
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const code = await runSmoke(realDeps(composeCli), problemId, {
    diskThresholdPercent: 90,
    timeoutMs: 180_000,
    pollMs: 3_000,
  });
  process.exit(code);
}

if (import.meta.main) {
  void main();
}
/* v8 ignore stop */
