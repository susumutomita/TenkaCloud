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
  /**
   * Phase 3 addition: when the verdict was computed, from the same injectable clock the rest of
   * this package uses (never `Date.now()` read directly by a caller). Populated by
   * `evaluatePatch` — a hand-built `PatchEvaluation` literal must supply it explicitly, the same
   * way it must already supply `verdict`/`reasons`.
   */
  readonly generatedAt: string;
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
 * (`validateSecurityHarnessDefinition` in ./validators.ts). `sandboxPolicy` / `search` from the
 * issue's full proposal are Phase 2 concerns and are intentionally not declared yet — adding them
 * later is additive.
 *
 * `revealPolicy` is a Phase 3 addition and is declared `readonly revealPolicy?:` (optional) so
 * that Phase 1 definitions which predate it — including the fixture in
 * `test/validators.test.ts` — remain valid without a reshape. A definition that omits it gets the
 * fail-closed default from `./reveal-policy.ts` (`DEFAULT_REVEAL_POLICY`), never an
 * implicitly-wide-open one.
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
  readonly revealPolicy?: RevealPolicy;
}

/**
 * Phase 3 addition (Issue #3036 spoiler boundary): the closed set of things a patch-evaluation /
 * run-timeline projection could ever choose to reveal. This union is deliberately closed (not
 * `string`) so that `./reveal-policy.ts`'s `PARTICIPANT_ALLOWED_REVEAL_FIELDS` ceiling and
 * `validateSecurityHarnessDefinition`'s field check both fail a typo or a not-yet-reviewed field
 * name at compile time / validation time instead of silently allowing it through.
 *
 * Declaring a field here does NOT mean a participant may ever see it — see
 * `PARTICIPANT_ALLOWED_REVEAL_FIELDS` in `./reveal-policy.ts` for the actual (much smaller)
 * participant ceiling. Fields such as `witness-digests`, `verdict-reasons`,
 * `forbidden-side-effects`, `budget-usage`, `verification-metadata`, `failure-reasons`, and
 * `redacted-transcript-ref` exist here only so an organizer-facing revealPolicy can name them —
 * they are never in the participant ceiling. `verdict-reasons` covers the issue's "failure
 * reason" wording too (a `PatchEvaluation.reasons` entry IS the failure/success reason in every
 * branch of `evaluatePatchVerdict`) — there is no separate token for it.
 */
export type RevealField =
  | "status"
  | "bounded-claim-notice"
  | "golden-test-results"
  | "generated-at"
  | "verdict-reasons"
  | "witness-digests"
  | "target-patch-digests"
  | "forbidden-side-effects"
  | "budget-usage"
  | "verification-metadata"
  | "redacted-transcript-ref";

/**
 * Wire shape for `SecurityHarnessDefinition.revealPolicy` (Issue #3036 contract:
 * `revealPolicy.participantCanSee` / `organizerCanSee`). This type only fixes the SHAPE a problem
 * author may configure — it is not itself an enforcement mechanism. Enforcement (clamping
 * `participantCanSee` to a fixed ceiling regardless of what is configured here) lives in
 * `./reveal-policy.ts`, which every participant-facing projection in this package must go
 * through.
 */
export interface RevealPolicy {
  readonly participantCanSee: readonly RevealField[];
  readonly organizerCanSee: readonly RevealField[];
}
