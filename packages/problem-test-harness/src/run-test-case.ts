/**
 * [Problem Test Harness / Issue #2107] Run one author-declared fixture.
 *
 * Pipeline (all deterministic, no I/O / network / cloud SDKs):
 *   1. Validate the fixture's `metadata` through the SDK `validateProblemMetadata`
 *      — the SINGLE validation source shared with #2106 / #2088. The harness adds
 *      NO second validator.
 *   2. If the problem declares scoring, run the deterministic scorer over the
 *      faked `outputs` / `probeResults`. A `failed` deployment is never scored.
 *   3. Classify the case as passed/failed by comparing the actual outcome to the
 *      author's `expected`.
 */

import { type ProblemRuntimeDescriptor, validateProblemMetadata } from "@tenkacloud/problem-sdk";
import { runScorer } from "./scorer.js";
import type { ProblemScoringMetadata } from "./scoring-types.js";
import type {
  HarnessDiagnostic,
  ProblemTestCase,
  ProblemTestResult,
  ScoreOutcome,
} from "./types.js";

/** The kinds the harness recognizes — exactly the public union discriminants. */
const SCORING_KINDS: ReadonlySet<string> = new Set([
  "flag",
  "multi-flag",
  "uptime",
  "uptime-flat",
  "uptime-multi",
  "phased-polling",
  "attack-detection",
  "composite-probe",
]);

/**
 * Narrow an already-SDK-validated `scoring` value to the public
 * {@link ProblemScoringMetadata} union by its `kind` discriminant. This is NOT a
 * validator (the SDK decided validity); it only lets the scorer dispatch over a
 * known shape. Returns `undefined` when the problem declares no scoring.
 */
function narrowScoring(scoring: unknown): ProblemScoringMetadata | undefined {
  if (!scoring || typeof scoring !== "object" || Array.isArray(scoring)) return undefined;
  const kind = (scoring as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !SCORING_KINDS.has(kind)) return undefined;
  return scoring as ProblemScoringMetadata;
}

/** Composite runtime target ids, used to reject undeclared composite-probe references. */
function declaredTargetIds(runtime: ProblemRuntimeDescriptor): readonly string[] {
  if ("kind" in runtime && runtime.kind === "composite") {
    return runtime.targets.map((target) => target.id);
  }
  return [];
}

/** Stable sort so equal input yields byte-identical diagnostics ordering. */
function sortDiagnostics(diagnostics: readonly HarnessDiagnostic[]): HarnessDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

/**
 * Run one fixture and produce a {@link ProblemTestResult}. Every result names the
 * pack id, problem id, and test case, and lists every diagnostic (each with a
 * machine-readable code) so the case is fully self-describing.
 */
export function runTestCase(packId: string, testCase: ProblemTestCase): ProblemTestResult {
  const problemId = testCase.metadata.id;
  const diagnostics: HarnessDiagnostic[] = [];

  const validationDiagnostics = validateProblemMetadata(testCase.metadata);
  for (const diagnostic of validationDiagnostics) {
    diagnostics.push({
      code: diagnostic.code,
      path: diagnostic.path,
      message: diagnostic.message,
    });
  }
  const valid = validationDiagnostics.length === 0;

  const scoring = narrowScoring(testCase.metadata.scoring);
  let score: ScoreOutcome | undefined;
  if (scoring) {
    if (testCase.deployment === "failed") {
      // A failed deploy can never feed the scorer — this is "not-runnable", not a
      // probe failure, so authors can tell a deploy problem from a scoring miss.
      score = "not-runnable";
      diagnostics.push({
        code: "SCORING_DEPLOY_FAILED",
        path: "deployment",
        message: "deployment fixture is 'failed', so the scorer cannot run.",
      });
    } else {
      const result = runScorer({
        scoring,
        outputs: testCase.outputs ?? {},
        probeResults: testCase.probeResults ?? {},
        declaredTargetIds: declaredTargetIds(testCase.runtime),
      });
      score = result.outcome;
      diagnostics.push(...result.diagnostics);
    }
  }

  const sorted = sortDiagnostics(diagnostics);
  const passed = matchesExpectation(testCase, valid, score, sorted);

  return {
    packId,
    problemId,
    testCase: testCase.name,
    passed,
    valid,
    ...(score ? { score } : {}),
    diagnostics: sorted,
  };
}

/** A case passes when validity, score, and every expected diagnostic code match. */
function matchesExpectation(
  testCase: ProblemTestCase,
  valid: boolean,
  score: ScoreOutcome | undefined,
  diagnostics: readonly HarnessDiagnostic[],
): boolean {
  const { expected } = testCase;
  if (expected.valid !== valid) return false;
  if (expected.score !== undefined && expected.score !== score) return false;
  if (expected.diagnostics) {
    const present = new Set(diagnostics.map((d) => d.code));
    for (const code of expected.diagnostics) {
      if (!present.has(code)) return false;
    }
  }
  return true;
}
