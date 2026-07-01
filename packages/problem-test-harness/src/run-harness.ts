/**
 * [Problem Test Harness / Issue #2107] Run a suite of fixtures and summarize.
 *
 * Pure and deterministic: the per-case results keep the author's declared order,
 * and the JSON summary is byte-identical for equal input. No I/O happens here —
 * fixture loading lives in the pack runner / CLI so this stays a pure function.
 */

import { runTestCase } from "./run-test-case.js";
import type { HarnessResult, ProblemTestCase, ProblemTestResult } from "./types.js";

/**
 * Run every fixture for one pack and return a {@link HarnessResult}. Results
 * preserve the input order; `passed` / `failed` / `ok` summarize the run.
 */
export function runHarness(packId: string, cases: readonly ProblemTestCase[]): HarnessResult {
  const results: ProblemTestResult[] = cases.map((testCase) => runTestCase(packId, testCase));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  return { packId, results, passed, failed, ok: failed === 0 };
}

/**
 * Serialize a {@link HarnessResult} to a stable, machine-readable JSON string.
 * The key order is fixed by the object literals above, so equal input always
 * produces the identical string (issue #2107 §6 + `returns stable JSON result
 * ordering`).
 */
export function toJsonResult(result: HarnessResult): string {
  return JSON.stringify(result, null, 2);
}
