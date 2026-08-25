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
 * Also in this package (Issue #3036 Phase 2 — Recon / Finder / adapter / dedupe only; independent
 * Verifier confirmation, patch evaluation, the artifact store, the audit timeline, and
 * participant/organizer reveal policy are separate follow-up work):
 *   - `ModelProvider`, the provider-neutral model adapter contract (`./model-provider.ts`), and
 *     `FixtureModelProvider`, the model-free deterministic implementation of it
 *     (`./fixture-model-provider.ts`) — no live provider is implemented in this package;
 *   - `planRecon`, threat-model-driven focus-area partitioning (`./recon.ts`);
 *   - `runFinders`, N-Finder parallel fan-out through a `ModelProvider` with a per-task isolation
 *     contract and rate-limit/timeout/model-error checkpoint-and-resume (`./finder-orchestration.ts`);
 *   - `extractFinderHandoff`, the PoC-only handoff schema restriction that keeps Finder reasoning,
 *     self-assessment, severity, and conclusions out of anything forwarded toward verification
 *     (`./finder-output.ts`);
 *   - `dedupeFindings`, deterministic-signature deduplication of candidate findings (`./dedupe.ts`).
 *
 * Explicitly NOT in this package: a live model provider (Claude or otherwise), an independent
 * Verifier that re-confirms a witness in a fresh sandbox, patch evaluation wiring, a real
 * container/Simulator execution plane, or any product/portal wiring.
 */

export type { DedupeGroup, DedupeManifest } from "./dedupe.js";
export { canonicalJsonStringify, computeDeterministicSignature, dedupeFindings } from "./dedupe.js";
export { digestOfOwnSource, sha256Hex, toDigestRef } from "./digest.js";
export type { EvaluateFindingInput } from "./evaluate-finding.js";
export { evaluateFindingVerdict } from "./evaluate-finding.js";
export { evaluatePatch, evaluatePatchVerdict } from "./evaluate-patch.js";
export type {
  FinderPrompt,
  FinderRetryPolicy,
  FinderSessionDescriptor,
  FinderTaskCheckpoint,
  FinderTaskStatus,
  RunFindersOptions,
  RunFindersResult,
} from "./finder-orchestration.js";
export { runFinders } from "./finder-orchestration.js";
export type {
  ExtractFinderHandoffInput,
  FinderHandoff,
  FinderHandoffResult,
  FinderTargetMetadata,
} from "./finder-output.js";
export { extractFinderHandoff } from "./finder-output.js";
export type { FixtureModelProviderOptions } from "./fixture-model-provider.js";
export { FixtureModelProvider, fixtureFailure, fixtureSuccess } from "./fixture-model-provider.js";
export type {
  ModelProvider,
  ModelProviderError,
  ModelProviderErrorKind,
  ModelProviderRequest,
  ModelProviderResponse,
  ModelProviderResult,
  ModelProviderUsage,
} from "./model-provider.js";
export { isRetryableModelProviderError } from "./model-provider.js";
export type {
  GoldenTestResult,
  Phase1SliceOptions,
  Phase1SliceResult,
  TargetVariant,
} from "./phase1-slice.js";
export { runPhase1Slice } from "./phase1-slice.js";
export type {
  ReconFinderAssignment,
  ReconPlan,
  ReconThreatModel,
  ThreatModelFocusArea,
} from "./recon.js";
export { planRecon } from "./recon.js";
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
