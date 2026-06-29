/**
 * @tenkacloud/problem-test — the deterministic, offline local problem test
 * harness for TenkaCloud problem packs (#2107).
 *
 * A Pack author declares pure-data fixtures (a {@link ProblemTestCase}) and the
 * harness validates the author-declared contract and runs the configured scorer
 * against faked deploy outputs and faked probe results. Guarantees:
 *
 *   - Validation reuses `@tenkacloud/problem-sdk` as the SINGLE source of truth
 *     (no second validator) — the same behavior as #2106 / #2088.
 *   - Fully deterministic and offline: no AWS / GCP / Azure / Sakura / Docker /
 *     shell / network / credentials; equal input always yields equal output.
 *   - Local contract success is NOT real-cloud certification.
 *
 * The harness validates declared contracts only; it never synthesizes IaC,
 * deploys, runs a Pack's shell, evaluates portal/coordination components, or
 * makes a real HTTP probe.
 */

export { formatSummary } from "./format.js";
export { runPackTests } from "./pack-runner.js";
export { runHarness, toJsonResult } from "./run-harness.js";
export { runTestCase } from "./run-test-case.js";
export {
  runScorer,
  SCORING_DIAGNOSTIC_CODES,
  type ScoreInput,
  type ScoreResult,
} from "./scorer.js";
export {
  type FakeProbeResult,
  HARNESS_EXIT_OK,
  HARNESS_EXIT_TEST_FAILURE,
  HARNESS_EXIT_TOOL_ERROR,
  type HarnessDiagnostic,
  HarnessError,
  type HarnessResult,
  type ProblemTestCase,
  type ProblemTestExpectation,
  type ProblemTestResult,
  type ScoreOutcome,
} from "./types.js";
