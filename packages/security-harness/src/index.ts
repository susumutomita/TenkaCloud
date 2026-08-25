/**
 * @tenkacloud/security-harness — Issue #3036 Phase 0/1: the versioned contracts and the
 * deterministic run state machine / verdict engine for TenkaCloud's independent-verification
 * security drill harness.
 *
 * Scope of this package (see `docs/architecture/decisions/0001-security-harness-trust-boundary.md`):
 *   - the `SecurityHarnessDefinition` / `FindingEvidence` / `PatchEvaluation` wire contracts;
 *   - the `SecurityRun` state machine (`transitionSecurityRun`), pure and idempotent;
 *   - the `http-sequence` witness schema, validator, and executor;
 *   - the baseline finding verdict (`evaluateFindingVerdict`) and patch verdict
 *     (`evaluatePatchVerdict` / `evaluatePatch`) rules — the "evidence over prose" scoring
 *     contract, expressed as pure, total, unit-testable functions;
 *   - `runPhase1Slice`, the reference wiring of all of the above around a real (not mocked)
 *     in-process HTTP fixture, proving the contract end to end without a model, Docker, or the
 *     network.
 *
 * Explicitly NOT in this package: an LLM/model provider adapter, an autonomous Finder/Recon loop,
 * a real container/Simulator execution plane, or any product/portal wiring — all Phase 2/3
 * per the issue.
 */

export { digestOfOwnSource, sha256Hex, toDigestRef } from "./digest.js";
export type { EvaluateFindingInput } from "./evaluate-finding.js";
export { evaluateFindingVerdict } from "./evaluate-finding.js";
export { evaluatePatch, evaluatePatchVerdict } from "./evaluate-patch.js";
export type {
  GoldenTestResult,
  Phase1SliceOptions,
  Phase1SliceResult,
  TargetVariant,
} from "./phase1-slice.js";
export { runPhase1Slice } from "./phase1-slice.js";
export {
  canTransition,
  IllegalSecurityRunTransitionError,
  isTerminalState,
  TERMINAL_STATES,
  transitionSecurityRun,
} from "./run-state-machine.js";
export type {
  CommandContract,
  FindingEvidence,
  FindingVerdict,
  HttpSequenceWitness,
  HttpWitnessStep,
  PatchEvaluation,
  PatchEvaluationInput,
  PatchVerdict,
  ProbeContract,
  SecurityHarnessDefinition,
  SecurityRunState,
  TestContract,
  WitnessType,
} from "./types.js";
export { validateSecurityHarnessDefinition } from "./validators.js";
export type {
  HttpClient,
  HttpResponseLike,
  ValidationResult,
  WitnessRunResult,
  WitnessStepOutcome,
} from "./witness.js";
export { runHttpSequenceWitness, validateHttpSequenceWitness } from "./witness.js";
