/**
 * @tenkacloud/problem-sdk — the ONLY supported public authoring contract for
 * TenkaCloud problem packs (#2106).
 *
 * This is the narrow surface Pack authors and external test tooling depend on:
 * serializable data-contract types, pure validation functions, constants, and
 * stable namespaced diagnostic codes. It deliberately hides every platform
 * internal — there are no control-plane handlers, deployment repositories,
 * credential stores, EventBridge contracts, CDK constructs, AWS SDK clients,
 * Lambda runtime modules, or browser-framework code here.
 *
 * Contract guarantees (see the issue):
 *   - exports are serializable data contracts or pure validation interfaces only;
 *   - every function is deterministic — no env vars, clock, network, cloud SDKs,
 *     or process-global state. `validatePackDirectory` is the ONLY function that
 *     reads the filesystem, and it is pure-deterministic given the directory;
 *   - diagnostics carry `code` / `path` / `message` / optional `hint`, with codes
 *     namespaced `PACK_*` / `PROBLEM_*` / `RUNTIME_*` / `SCORING_*`;
 *   - additive exports are allowed in a minor version; removal or a semantic
 *     change requires a major version.
 *
 * The exact set of exported names is frozen and asserted in CI
 * (`test/public-api-surface.test.ts`).
 */

// --- Types (serializable data contracts / pure validation interfaces) ---
export type {
  CompositeRuntimeDescriptor,
  ProblemRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
export type { ValidationDiagnostic } from "./diagnostics.js";
export type { PackManifest } from "./manifest.js";
// --- Values (constants + pure validators) ---
export { PACK_SCHEMA_VERSION } from "./manifest.js";
export type { PackProblem, ProblemMetadata } from "./problem-metadata.js";
export { validateProblemMetadata } from "./problem-metadata.js";
export { formatDiagnostics, validatePackManifest } from "./public-validators.js";
export type {
  BuildPackReportOptions,
  PackReport,
  PackReportResult,
} from "./report.js";
export { buildPackReport, computeContentDigest, serializePackReport } from "./report.js";
export type { RuntimeCapability } from "./runtime-capability.js";
export { SUPPORTED_RUNTIME_CAPABILITIES } from "./runtime-capability.js";
export type { ProblemScoringMetadata } from "./scoring-metadata.js";
export { validatePackDirectory } from "./validate-pack.js";
