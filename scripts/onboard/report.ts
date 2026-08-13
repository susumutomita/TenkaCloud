/**
 * [Issue #2119] Pure formatting for the onboarding doctor / preflight output.
 * Kept separate (and string-returning) so the wording is unit-testable without
 * capturing stdout.
 */

import type { CheckResult, Diagnosis } from "./diagnose";
import type { RemediationStep } from "./plan";

const STATUS_ICON: Record<CheckResult["status"], string> = {
  ok: "✓",
  missing: "✗",
  "action-needed": "!",
  skipped: "·",
};

/** One line per check: `✓ Bun — bun 1.3.11`. */
export function formatCheckLine(check: CheckResult): string {
  return `  ${STATUS_ICON[check.status]} ${check.title} — ${check.detail}`;
}

/** The full developer doctor report (status of every host Bun/Vite prerequisite). */
export function formatDiagnosis(diagnosis: Diagnosis): string {
  return ["TenkaCloud developer prerequisites:", ...diagnosis.checks.map(formatCheckLine)].join(
    "\n",
  );
}

/** A single remediation step rendered for the user (why + commands + notes). */
export function formatStep(step: RemediationStep, index: number, total: number): string {
  const lines = [`[${index + 1}/${total}] ${step.title}`, `  Why: ${step.why}`];
  if (step.commands.length > 0) {
    lines.push("  Run:");
    for (const command of step.commands) lines.push(`    ${command}`);
  }
  if (step.notes) lines.push(`  Note: ${step.notes}`);
  return lines.join("\n");
}

/**
 * Closing guidance when one or more steps were left for the user (declined auto
 * or non-interactive). Lists the copy-pasteable commands and the resume command.
 */
export function formatManualGuidance(
  steps: readonly RemediationStep[],
  resumeCommand: string,
): string {
  const blocks = steps.map((step, i) => formatStep(step, i, steps.length));
  return [
    "",
    "Some prerequisites still need your action:",
    "",
    ...blocks,
    "",
    `After completing the above, re-run:  ${resumeCommand}`,
  ].join("\n");
}
