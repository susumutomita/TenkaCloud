/**
 * @tenkacloud/problem-sdk/internal — the Core-monorepo-only entrypoint.
 *
 * NOT part of the public authoring contract (`@tenkacloud/problem-sdk`). The
 * TenkaCloud Core repo imports the moved-but-not-yet-public building blocks from
 * here (the manifest schema object, the pure section parsers, the pack-validator
 * types, the safe-path helpers) so that the infra `lib/problem-pack/*` and
 * `lib/utils/*` modules can re-export them with their existing names/signatures
 * unchanged. External Pack authors must depend on the package root instead.
 */

// Pack-validator + diagnostics.
export type { PackDiagnostic, PackDiagnosticCode } from "./diagnostics.js";
// Pure endpoints-metadata section parser + types.
export {
  type ProblemEndpointSlot,
  type ProblemEndpointSlotDefault,
  parseEndpointSlot,
  resolveDefaultUrl,
} from "./endpoints-metadata.js";
export type {
  PackManifest,
  PackManifestIssue,
  PackManifestParseResult,
  ProviderEngineCapability,
} from "./manifest.js";
// Manifest schema + parser internals.
export {
  PACK_PROVIDERS,
  PACK_SCHEMA_VERSION,
  PackManifestSchema,
  parsePackManifest,
  satisfiesCoreRange,
} from "./manifest.js";
// Pure phases / disruptions section parsers + types.
export {
  DISRUPTION_ACTION_KINDS,
  DISRUPTION_EFFECT_MAX_DURATION_SECONDS,
  type DisruptionAction,
  type DisruptionActionKind,
  type DisruptionActionRevert,
  type DisruptionEffect,
  type DisruptionTrigger,
  type ProblemDisruptionEntry,
  type ProblemPhaseEntry,
  parseDisruptionAction,
  parseDisruptionEffect,
  parseDisruptionEntry,
  parseDisruptionRecurrence,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
  parsePhaseEntry,
} from "./metadata-parser.js";
export { type ProblemMetadataView, validateMetadataSections } from "./metadata-sections.js";
export type { PackProblem } from "./problem-metadata.js";
// Pack-file walk shared with the Core snapshot installer, so the copied file set
// is exactly the digested file set (#2866).
export { type CollectedPackFile, collectPackFiles } from "./report.js";
export { isExistingDirectory, isInside, readDirNames, resolveInside } from "./safe-path.js";
// Pure scoring-metadata section parsers + types.
export {
  type AttackDetectionCategory,
  type AttackDetectionScoringMetadata,
  type CompositeProbeScoringMetadata,
  type CompositeProbeTarget,
  type FlagScoringMetadata,
  type HintRevealMode,
  type MultiFlagEntry,
  type MultiFlagScoringMetadata,
  type PhasedPollingBonus,
  type PhasedPollingPlatformRule,
  type PhasedPollingResponsePenalty,
  type PhasedPollingScoringMetadata,
  type ProblemScoringMetadata,
  type ProgressiveHint,
  parseScoringMetadata,
  type UptimeFlatEndpoint,
  type UptimeFlatScoringMetadata,
  type UptimeMultiProbedSlot,
  type UptimeMultiScoringMetadata,
} from "./scoring-metadata.js";
export {
  PACK_MANIFEST_FILENAME,
  type PackValidationResult,
  validatePackDirectory,
} from "./validate-pack.js";
