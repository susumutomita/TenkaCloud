/**
 * [Problem Test Harness / Issue #2107] Public data contracts for the deterministic,
 * offline local problem test harness.
 *
 * A Pack author declares fixtures (metadata + runtime + faked deployment outputs +
 * faked probe results) and the expected outcome. The harness validates the
 * author-declared contract through `@tenkacloud/problem-sdk` (the single
 * validation source) and runs the configured scorer against the fixtures using
 * injected fakes only. It NEVER touches AWS / GCP / Azure / Sakura / Docker /
 * shell / network / credentials, and the same input always yields the same output.
 *
 * These types are serializable data contracts. The error *string* is never the
 * contract — assertions key on `code` / `score` / `valid`.
 */

import type { ProblemMetadata, ProblemRuntimeDescriptor } from "@tenkacloud/problem-sdk";

/**
 * A faked CloudFormation-style probe outcome for one declared output URL. The
 * harness never performs a real HTTP request: the author supplies the status the
 * provider *would* return. `status` is the HTTP status the fake endpoint returns;
 * `reachable === false` models a connection-level failure (no status at all).
 */
export interface FakeProbeResult {
  readonly status?: number;
  readonly reachable?: boolean;
}

/**
 * The classification of a single scored fixture.
 *   - `success`      — the scorer would award points (all gates passed).
 *   - `failure`      — the scorer ran but the fixture did not satisfy the gates.
 *   - `not-runnable` — the scorer could not run (missing output key, invalid
 *                      target reference, malformed scoring), so no score is
 *                      possible. Distinct from `failure` so an author can tell a
 *                      wiring error from a genuine non-passing probe.
 */
export type ScoreOutcome = "success" | "failure" | "not-runnable";

/** The expected outcome an author declares for a fixture. */
export interface ProblemTestExpectation {
  /** Whether the SDK validation is expected to pass with no diagnostics. */
  readonly valid: boolean;
  /** The expected scorer classification, when the problem declares scoring. */
  readonly score?: ScoreOutcome;
  /**
   * Diagnostic *codes* expected to appear. Each entry must be present in the
   * harness diagnostics for the case to pass. The order and any extra codes are
   * ignored — authors assert the codes they care about.
   */
  readonly diagnostics?: readonly string[];
}

/**
 * One author-declared local test fixture. `metadata` and `runtime` describe the
 * problem; `deployment` / `outputs` / `probeResults` describe the *faked* deploy
 * the scorer is fed; `expected` is the author's assertion.
 */
export interface ProblemTestCase {
  readonly name: string;
  readonly metadata: ProblemMetadata;
  readonly runtime: ProblemRuntimeDescriptor;
  /** Faked deploy lifecycle state. `failed` means the scorer must not run. */
  readonly deployment: "ready" | "failed";
  /** Faked CFn output values (OutputKey → value), e.g. `{ FlagValue: "T{...}" }`. */
  readonly outputs?: Record<string, string>;
  /** Faked probe results keyed by the URL/identifier the scorer would probe. */
  readonly probeResults?: Record<string, FakeProbeResult>;
  readonly expected: ProblemTestExpectation;
}

/**
 * One harness diagnostic. `code` is the stable contract (SDK
 * `ValidationDiagnosticCode` values plus the harness-local `HARNESS_*` /
 * `SCORING_*` codes); `path` locates the offending value; `message` is human
 * remediation text.
 */
export interface HarnessDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** The per-test-case result. Identifies pack, problem, case, and every diagnostic. */
export interface ProblemTestResult {
  readonly packId: string;
  readonly problemId: string;
  readonly testCase: string;
  /** Whether the actual outcome matched the author's `expected`. */
  readonly passed: boolean;
  /** Whether the SDK validation produced no diagnostics. */
  readonly valid: boolean;
  /** The scorer classification, or `undefined` for a deploy-only problem. */
  readonly score?: ScoreOutcome;
  /** Every diagnostic raised for this case, stable-sorted. */
  readonly diagnostics: readonly HarnessDiagnostic[];
}

/** The machine-readable harness summary. Stable ordering for byte-identical output. */
export interface HarnessResult {
  readonly packId: string;
  /** Per-case results, ordered exactly as the cases were declared. */
  readonly results: readonly ProblemTestResult[];
  readonly passed: number;
  readonly failed: number;
  /** True iff every case passed. Maps to exit code 0. */
  readonly ok: boolean;
}

/**
 * Harness process exit codes (issue #2107 §7):
 *   - 0 — every case passed
 *   - 1 — at least one case failed its assertion
 *   - 2 — a harness/tool error (a thrown {@link HarnessError})
 */
export const HARNESS_EXIT_OK = 0 as const;
export const HARNESS_EXIT_TEST_FAILURE = 1 as const;
export const HARNESS_EXIT_TOOL_ERROR = 2 as const;

/**
 * A harness/tool error — distinct from a failed test assertion. Thrown when the
 * harness itself cannot run (e.g. a pack directory that does not exist, an
 * unreadable tests file). The CLI maps this to exit code 2, never 1.
 */
export class HarnessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}
