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
 * Also in this package (Issue #3036 Phase 2 — Recon / Finder / adapter / dedupe):
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
 * And (Issue #3036 Phase 3): the participant/organizer spoiler boundary (`./reveal-policy.ts`),
 * the run timeline + JSON/JSONL export (`./run-timeline.ts`), and the artifact metadata / access
 * control / retention / secret-redaction reference store (`./artifact-store.ts`,
 * `./secret-redaction.ts`). None of these read `scoring.attackProbes` or change its wire shape —
 * see `./run-timeline.ts`'s header comment for how the two coexist.
 *
 * Explicitly NOT in this package: a live model provider (Claude or otherwise), an independent
 * Verifier that re-confirms a witness in a fresh sandbox, a real container/Simulator execution
 * plane, or real S3/DynamoDB-backed artifact storage / a wired operator API or Participant Portal
 * route — Simulator-owned and Phase 4 / infra-wiring follow-up per the issue.
 */

export {
  ArtifactAccessDeniedError,
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactRecord,
  type ArtifactScope,
  ArtifactValidationError,
  type IngestArtifactFileInput,
  InMemoryArtifactStore,
  ingestArtifactFile,
  type PutArtifactInput,
} from "./artifact-store.js";
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
  BOUNDED_CLAIM_NOTICE,
  DEFAULT_REVEAL_POLICY,
  ORGANIZER_ALLOWED_REVEAL_FIELDS,
  type OrganizerPatchEvaluationView,
  PARTICIPANT_ALLOWED_REVEAL_FIELDS,
  type ParticipantPatchEvaluationView,
  type ParticipantPatchStatus,
  type PatchEvaluationProjectionInput,
  type PublicGoldenTestResult,
  projectPatchEvaluationForOrganizer,
  projectPatchEvaluationForParticipant,
  sanitizeRevealPolicy,
} from "./reveal-policy.js";
export {
  canTransition,
  IllegalSecurityRunTransitionError,
  isTerminalState,
  TERMINAL_STATES,
  transitionSecurityRun,
} from "./run-state-machine.js";
export type {
  OrganizerTimelineEvent,
  ParticipantRunPhase,
  ParticipantTimelineEvent,
  SecurityRunTimelineEvent,
  SecurityRunTimelineEventType,
} from "./run-timeline.js";
export {
  projectTimelineForOrganizer,
  projectTimelineForParticipant,
  TimelineRecorder,
  toTimelineJson,
  toTimelineJsonl,
} from "./run-timeline.js";
export type { RedactionResult } from "./secret-redaction.js";
export { redactSecrets } from "./secret-redaction.js";
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
  RevealField,
  RevealPolicy,
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
