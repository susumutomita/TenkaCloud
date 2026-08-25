/**
 * Versioned wire contracts for the security drill harness (Issue #3036 Phase 0).
 *
 * These types fix the shape the ADR (`docs/architecture/decisions/0001-security-harness-trust-boundary.md`)
 * decided on. Phase 1 only exercises the `http-sequence` witness type and a trimmed
 * `SecurityHarnessDefinition`; the remaining witness kinds and definition fields are declared
 * here so Phase 2/3 additions are additive, not a breaking reshape. Nothing in this file reads
 * the clock, the filesystem, the network, or `Math.random()` — every value here is plain data.
 */

/** Kept in sync with the issue body's `SecurityHarnessDefinition.witness.type` union. */
export type WitnessType =
  | "http-sequence"
  | "crash-input"
  | "executable-test"
  | "state-predicate"
  | "log-query";

/** One HTTP request/assertion pair inside an `http-sequence` witness. */
export interface HttpWitnessStep {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Must start with "/". No scheme/host — the executor supplies the target's own base URL. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly expectStatus: number;
  /** Substring the response body must contain for the step to pass, if given. */
  readonly expectBodyIncludes?: string;
  /** Substring the response body must NOT contain for the step to pass, if given. */
  readonly expectBodyExcludes?: string;
}

/**
 * A schema-validated, content-addressed witness bundle. This is the ONLY thing a Finder is
 * allowed to hand a Verifier (Issue #3036 "PoC-only handoff") — no reasoning, no self-assessed
 * severity, no free text.
 */
export interface HttpSequenceWitness {
  readonly type: "http-sequence";
  readonly witnessId: string;
  readonly focusArea: string;
  readonly steps: readonly HttpWitnessStep[];
}

export type SecurityRunState =
  | "QUEUED"
  | "BUILDING"
  | "RECONNING"
  | "FINDING"
  | "VERIFYING"
  | "DEDUPING"
  | "READY_FOR_REMEDIATION"
  | "VALIDATING_PATCH"
  | "REATTACKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INCONCLUSIVE";

export type FindingVerdict = "confirmed" | "rejected" | "inconclusive";

export interface FindingEvidence {
  readonly runId: string;
  readonly findingId: string;
  readonly targetDigest: string;
  readonly threatModelDigest: string;
  readonly focusArea: string;
  readonly witnessType: WitnessType;
  readonly witnessDigest: string;
  readonly reproduction: {
    readonly attempts: number;
    readonly successes: number;
    readonly freshEnvironment: boolean;
  };
  readonly verifier: {
    readonly id: string;
    readonly version: string;
    readonly policyDigest: string;
  };
  readonly verdict: FindingVerdict;
  readonly generatedAt: string;
}

export type PatchVerdict = "verified-fixed" | "still-vulnerable" | "regressed" | "inconclusive";

export interface PatchEvaluationInput {
  readonly runId: string;
  readonly baselineTargetDigest: string;
  readonly patchDigest: string;
  readonly baselineFinding: FindingEvidence;
  readonly build: "passed" | "failed";
  readonly goldenBehavior: "passed" | "failed" | "inconclusive";
  readonly originalWitnessReplay: "blocked" | "landed" | "inconclusive";
  readonly freshReattack: "no-witness-found" | "witness-confirmed" | "inconclusive";
  /** Structural violations detected outside the pass/fail results above (e.g. sandbox breakout attempt). */
  readonly forbiddenSideEffects: readonly string[];
  /**
   * True only when the orchestrator has itself confirmed that `baselineTargetDigest` is what the
   * baseline finding actually ran against AND `patchDigest` is what every patch-stage check
   * actually ran against. A caller-asserted `true` with mismatched digests is a bug in the
   * caller, not something this type can catch — the digests must be computed, not declared.
   */
  readonly digestsMatch: boolean;
}

export interface PatchEvaluation extends PatchEvaluationInput {
  readonly verdict: PatchVerdict;
  /** Evidence-derived justification strings only — never LLM prose or a self-assessment. */
  readonly reasons: readonly string[];
}

export interface CommandContract {
  readonly operationId: string;
  readonly args?: Readonly<Record<string, string>>;
}

export interface ProbeContract {
  readonly path: string;
  readonly expectedStatus: number;
  readonly timeoutMs: number;
}

export interface TestContract {
  readonly id: string;
  readonly description: string;
}

/**
 * Trimmed to the fields Phase 1 actually reads and validates
 * (`validateSecurityHarnessDefinition` in ./validators.ts). `sandboxPolicy` / `revealPolicy` /
 * `search` from the issue's full proposal are Phase 2/3 concerns and are intentionally not
 * declared yet — adding them later is additive.
 */
export interface SecurityHarnessDefinition {
  readonly version: "tenkacloud.security-harness.v1";
  readonly target: {
    readonly artifactDigest: string;
    readonly runtime: "container";
    readonly build: CommandContract;
    readonly start: CommandContract;
    readonly readiness: ProbeContract;
    readonly goldenTests: readonly TestContract[];
  };
  readonly engagement: {
    readonly threatModelDigest: string;
    readonly allowedTargetIds: readonly string[];
    readonly allowedNetworkScopes: readonly string[];
    readonly nonGoals: readonly string[];
  };
  readonly witness: {
    readonly type: WitnessType;
    readonly verifierId: string;
    readonly minimumReproductions: number;
  };
  readonly budget: {
    readonly wallClockSeconds: number;
    readonly maxToolCalls: number;
  };
}
