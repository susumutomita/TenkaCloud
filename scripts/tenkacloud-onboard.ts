/**
 * [Issue #2119] Optional onboarding entry for local play.
 *
 *   bun run scripts/tenkacloud-onboard.ts doctor      # report prerequisites only
 *   bun run scripts/tenkacloud-onboard.ts preflight   # diagnose → consent → fix
 *
 * Flags: `--yes` pre-approves software installs (also used by automation). In a
 * non-interactive run (no TTY / CI) without `--yes`, nothing is installed — the
 * missing prerequisites are reported as the failure reason.
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

function doctor(): number {
  const result = diagnose(diagnoseInput());
  console.log(formatDiagnosis(result));
  if (isReady(result)) {
    console.log("\nAll prerequisites are satisfied — run `tenkacloud local`.");
    return 0;
  }
  console.log(
    "\nSome prerequisites need action. Run `tenkacloud onboard` (it will offer to set them up), " +
      "or fix them manually with the commands from `tenkacloud doctor`.",
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
    console.log("\n✓ All prerequisites satisfied.");
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
  const command = args.find((arg) => !arg.startsWith("-")) ?? "doctor";
  switch (command) {
    case "doctor":
      process.exitCode = doctor();
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
