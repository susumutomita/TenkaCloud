/**
 * [Problem Test Harness / Issue #2107] Deterministic human-readable summary.
 *
 * `formatSummary` renders a per-problem, per-case summary. It is pure: equal
 * input always renders to a byte-identical string (no clock, colors, or
 * environment). The machine-readable form is `toJsonResult` in `run-harness.ts`.
 */

import type { HarnessResult, ProblemTestResult } from "./types.js";

/** Render a per-problem summary. Each case line identifies problem id and case name. */
export function formatSummary(result: HarnessResult): string {
  const lines: string[] = [`pack ${result.packId}`];
  for (const caseResult of result.results) {
    lines.push(formatCaseLine(caseResult));
    for (const diagnostic of caseResult.diagnostics) {
      lines.push(`    [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  lines.push(`${result.passed} passed, ${result.failed} failed`);
  return lines.join("\n");
}

function formatCaseLine(caseResult: ProblemTestResult): string {
  const status = caseResult.passed ? "PASS" : "FAIL";
  const score = caseResult.score ? ` score=${caseResult.score}` : "";
  return `  ${status} ${caseResult.problemId} :: ${caseResult.testCase} (valid=${caseResult.valid}${score})`;
}
