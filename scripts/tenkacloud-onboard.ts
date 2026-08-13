/**
 * [Issue #2119] Optional onboarding entry for the host Bun/Vite developer path.
 *
 *   make doctor-dev                                   # report developer prerequisites only
 *   bun run scripts/tenkacloud-onboard.ts preflight   # diagnose → consent → fix
 *
 * Flags: `--yes` pre-approves software installs (also used by automation). In a
 * non-interactive run (no TTY / CI) without `--yes`, nothing is installed — the
 * missing prerequisites are reported as the failure reason.
 *
 * [Issue #2909] `--profile <minimum|recommended|full>` additionally compares the
 * resources Docker actually has against what that profile has been measured in.
 * CPU and memory comparisons are advisory because being below an observed
 * configuration is untested, not broken. `--probe-disk` opts in to the one check
 * that is not read-only (it pulls busybox to read the Docker VM's free space).
 * A measured disk shortage is a hard failure because the required image cannot
 * materialise; an unread disk remains `unknown`.
 *
 * This file is deliberately a thin orchestrator: the detection interpretation,
 * the remediation plan, the consent policy, and the formatting are pure,
 * unit-tested modules under `scripts/onboard/`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  DOCKER_INFO_FORMAT,
  parseDiskAvailableBytes,
  parseDockerInfo,
} from "./local/docker-metrics";
import { evaluateProfile, formatPreflight, type PreflightFacts } from "./local/profile-preflight";
import { findProfile, isProfileId, type ProfileId } from "./local/profiles";
import {
  blockingChecks,
  type CommandRunner,
  type DiagnoseInput,
  diagnose,
  isReady,
} from "./onboard/diagnose";
import {
  type Platform,
  planRemediation,
  type RemediationStep,
  resolveStepAction,
} from "./onboard/plan";
import { formatDiagnosis, formatManualGuidance, formatStep } from "./onboard/report";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Detection runner: argv form, never a shell, ENOENT → code:null (not installed). */
const nodeRunner: CommandRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { code: null, stdout: "", stderr: "" };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

function diagnoseInput(): DiagnoseInput {
  return { repoRoot: REPO_ROOT, run: nodeRunner, fs: { existsSync } };
}

/** Injectable so it's unit-testable, same pattern as diagnose()/plan(); defaults to the real platform. */
export function currentPlatform(platform: string = process.platform): Platform {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "other";
}

/** A human can answer a prompt: a TTY and not a CI run. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.CI;
}

/** Run a remediation command through the shell (commands may be pipelines). */
function runRemediation(command: string): boolean {
  console.log(`\n$ ${command}`);
  // `command` is never user input: it comes from the fixed `commands` literals in
  // scripts/onboard/plan.ts, several of which are shell pipelines (`curl -fsSL … | sh`)
  // and therefore need `shell: true`. The operator sees each command echoed above and
  // confirms it before it runs.
  // eslint-disable-next-line sonarjs/os-command -- fixed command table, operator-confirmed
  return spawnSync(command, { shell: true, stdio: "inherit" }).status === 0;
}

/**
 * [Issue #2909] Read `--profile <id>` out of argv.
 *
 * An unrecognised id is an error rather than a silent fallback to the default:
 * a typo would otherwise report a different profile's numbers under the name the
 * operator asked for.
 */
export function parseProfileFlag(args: readonly string[]): ProfileId | undefined {
  const index = args.indexOf("--profile");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error("--profile needs a value (minimum, recommended, or full)");
  }
  if (!isProfileId(value)) {
    throw new Error(`Unknown profile "${value}" (expected minimum, recommended, or full)`);
  }
  return value;
}

/**
 * The subcommand, defaulting to `doctor`.
 *
 * `--profile <id>`'s value is a bare word, so a naive "first non-flag argument"
 * search would read `recommended` as the command and fail with "Unknown command"
 * on a valid invocation.
 */
export function resolveCommand(args: readonly string[]): string {
  return (
    args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--profile") ?? "doctor"
  );
}

/**
 * Resource facts for the profile comparison. Everything unreadable stays
 * `undefined` so `profile-preflight.ts` reports `unknown` rather than passing a
 * host it could not measure.
 */
export function collectPreflightFacts(run: CommandRunner, probeDisk: boolean): PreflightFacts {
  const info = parseDockerInfo(run.run("docker", ["info", "--format", DOCKER_INFO_FORMAT]).stdout);
  if (!probeDisk) {
    return { dockerCpus: info.cpus, dockerMemoryBytes: info.memoryBytes };
  }
  // Not read-only: this pulls busybox, which is why it is opt-in. The host's own
  // free space is the wrong number on macOS/Windows, where images live in a VM.
  const probe = run.run("docker", ["run", "--rm", "busybox", "df", "-P", "/"]);
  return {
    dockerCpus: info.cpus,
    dockerMemoryBytes: info.memoryBytes,
    freeDiskBytes: probe.code === 0 ? parseDiskAvailableBytes(probe.stdout) : undefined,
  };
}

/**
 * CPU/memory warnings and unknown measurements are advisory. A disk value below
 * the measured image floor is known-broken and therefore blocks readiness.
 */
function reportProfile(profileId: ProfileId, probeDisk: boolean): boolean {
  const profile = findProfile(profileId);
  if (!profile) return true;
  const result = evaluateProfile(profile, collectPreflightFacts(nodeRunner, probeDisk));
  console.log("");
  console.log(formatPreflight(result));
  if (!probeDisk) {
    console.log("  (Pass --probe-disk to also measure Docker VM free space; it pulls busybox.)");
  }
  console.log("  Profile definitions: docs/local-play-requirements.md");
  return result.status !== "fail";
}

function doctor(profileId: ProfileId | undefined, probeDisk: boolean): number {
  const result = diagnose(diagnoseInput());
  console.log(formatDiagnosis(result));
  const profileReady = profileId ? reportProfile(profileId, probeDisk) : true;
  if (isReady(result) && profileReady) {
    console.log("\nAll developer prerequisites are satisfied — run `make local-dev`.");
    return 0;
  }
  if (isReady(result)) {
    console.log("\nA measured hard requirement needs action before `make local-dev`.");
    return 1;
  }
  console.log(
    "\nSome prerequisites need action. Run `tenkacloud onboard` (it will offer to set them up), " +
      "or fix them manually with the commands from `make doctor-dev`.",
  );
  return 1;
}

async function confirm(question: string): Promise<"yes" | "manual" | "no"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return "yes";
    if (answer === "m" || answer === "manual") return "manual";
    return "no";
  } finally {
    rl.close();
  }
}

/** Is `id` still among the blocking checks right now? (re-diagnoses live state) */
function stillBlocking(id: RemediationStep["id"]): boolean {
  return blockingChecks(diagnose(diagnoseInput())).some((check) => check.id === id);
}

async function applyStep(
  step: RemediationStep,
  index: number,
  total: number,
  autoYes: boolean,
): Promise<boolean> {
  // A prior step may have already resolved this one (e.g. installing Docker fixes
  // the CLI, Compose frontend, and the daemon at once).
  if (!stillBlocking(step.id)) return true;

  console.log(`\n${formatStep(step, index, total)}`);
  const action = resolveStepAction(step, { interactive: isInteractive(), autoYes });
  if (action === "manual") return false;

  if (action === "prompt") {
    const choice = await confirm("\nProceed? [y/N/manual] ");
    if (choice !== "yes") return false; // "no" / "manual" → leave for the user
  }

  for (const command of step.commands) {
    if (!runRemediation(command)) {
      console.error(`\nStep "${step.title}" failed at: ${command}`);
      return false;
    }
  }
  return true;
}

async function preflight(autoYes: boolean): Promise<number> {
  const initial = diagnose(diagnoseInput());
  console.log(formatDiagnosis(initial));
  if (isReady(initial)) return 0;

  const platform = currentPlatform();
  const steps = planRemediation(initial, { platform });
  for (let i = 0; i < steps.length; i++) {
    await applyStep(steps[i], i, steps.length, autoYes);
  }

  const after = diagnose(diagnoseInput());
  if (isReady(after)) {
    console.log("\n✓ All developer prerequisites satisfied. Next: run `make local-dev`.");
    return 0;
  }
  const remaining = planRemediation(after, { platform });
  console.error(formatManualGuidance(remaining, "tenkacloud onboard"));
  if (!isInteractive() && !autoYes) {
    console.error(
      "\n(Non-interactive run: software was not installed. Re-run with `--yes` to allow installs.)",
    );
  }
  return 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoYes = args.includes("--yes") || args.includes("-y");
  const profileId = parseProfileFlag(args);
  const probeDisk = args.includes("--probe-disk");
  const command = resolveCommand(args);
  switch (command) {
    case "doctor":
      process.exitCode = doctor(profileId, probeDisk);
      break;
    case "preflight":
      process.exitCode = await preflight(autoYes);
      break;
    default:
      console.error(`Unknown command: ${command} (expected "doctor" or "preflight")`);
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
