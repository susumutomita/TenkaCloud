/**
 * [Problem SDK / Issue #2106] Pure problem-`metadata.json` validation.
 *
 * `validateProblemMetadata(metadata)` accepts one already-`JSON.parse`d problem
 * metadata object and returns stable, namespaced {@link ValidationDiagnostic}s.
 * It reuses exactly the same building blocks as the pack validator
 * (`normalizeRuntime` from `@tenkacloud/problem-runtime`, the scoring parser, the
 * metadata-section validators) so the SDK and the platform never diverge on what
 * metadata they accept. Pure and deterministic: no I/O, env, clock, or network.
 */

import { classifyRuntimeSupport, normalizeRuntime } from "@tenkacloud/problem-runtime";
import type { PackDiagnostic } from "./diagnostics.js";
import { toValidationDiagnostic, type ValidationDiagnostic } from "./diagnostics.js";
import { validateMetadataSections } from "./metadata-sections.js";
import { isSupportedRuntimeCapability } from "./runtime-capability.js";
import type { ProblemScoringMetadata } from "./scoring-metadata.js";

/**
 * A pack-discovered problem: its stable id plus the pack-relative directory it
 * lives in. The serializable shape external tooling sees from a validated pack.
 */
export interface PackProblem {
  readonly id: string;
  readonly relDir: string;
}

/**
 * A problem's `metadata.json` as a serializable record. The SDK validates the
 * fields it owns (id / runtime / scoring) and is forward-compatible with extra
 * catalog-display fields it does not interpret.
 */
export interface ProblemMetadata {
  readonly id: string;
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
  readonly scoring?: ProblemScoringMetadata | unknown;
  readonly endpoints?: unknown;
  readonly phases?: unknown;
  readonly disruptions?: unknown;
  readonly [key: string]: unknown;
}

const METADATA_FILE = "metadata.json";

/**
 * Validate one problem's metadata. Returns an empty array when valid; otherwise
 * stable, namespaced diagnostics. Mirrors the per-problem checks the pack
 * validator runs (id presence, runtime normalization, runtime capability, and the
 * optional scoring / endpoints / phases / disruptions sections) but without any
 * filesystem artifact resolution (it is given metadata, not a directory).
 */
export function validateProblemMetadata(metadata: unknown): readonly ValidationDiagnostic[] {
  const internal: PackDiagnostic[] = [];

  if (!isRecord(metadata)) {
    internal.push({
      code: "METADATA_INVALID",
      file: METADATA_FILE,
      path: "",
      message: "metadata.json must be a JSON object.",
    });
    return internal.map(toValidationDiagnostic);
  }
  if (typeof metadata.id !== "string" || metadata.id.length === 0) {
    internal.push({
      code: "METADATA_INVALID",
      file: METADATA_FILE,
      path: "id",
      message: "metadata.json must declare a non-empty string 'id'.",
    });
  }

  validateMetadataSections({ metadataFile: METADATA_FILE, metadata }, internal);

  const runtimeDiagnostics = validateRuntime(metadata);
  internal.push(...runtimeDiagnostics);

  return internal.map(toValidationDiagnostic).sort(compareValidationDiagnostic);
}

function validateRuntime(metadata: Record<string, unknown>): PackDiagnostic[] {
  const diagnostics: PackDiagnostic[] = [];
  let runtime: ReturnType<typeof normalizeRuntime>;
  try {
    runtime = normalizeRuntime({
      id: typeof metadata.id === "string" ? metadata.id : undefined,
      runtime: metadata.runtime,
      cfnTemplate: metadata.cfnTemplate,
    });
  } catch (err) {
    return [
      {
        code: "METADATA_INVALID",
        file: METADATA_FILE,
        path: "runtime",
        message: `runtime declaration is invalid: ${(err as Error).message}.`,
      },
    ];
  }
  if (!runtime) {
    return [
      {
        code: "METADATA_INVALID",
        file: METADATA_FILE,
        path: "runtime",
        message: "runtime is present but malformed: provider/engine/entry must all be strings.",
      },
    ];
  }
  // Reject a runtime that names a provider/engine the platform does not recognize
  // (a typo or an unsupported capability) — composite runtimes check each target.
  const used =
    classifyRuntimeSupport(runtime) === "composite" && "targets" in runtime
      ? runtime.targets.map((t) => ({ provider: t.provider, engine: t.engine }))
      : "provider" in runtime
        ? [{ provider: runtime.provider, engine: runtime.engine }]
        : [];
  for (const { provider, engine } of used) {
    if (!isSupportedRuntimeCapability(provider, engine)) {
      diagnostics.push({
        code: "RUNTIME_MISMATCH",
        file: METADATA_FILE,
        path: "runtime",
        message: `runtime '${provider}/${engine}' is not a supported runtime capability.`,
      });
    }
  }
  return diagnostics;
}

function compareValidationDiagnostic(a: ValidationDiagnostic, b: ValidationDiagnostic): number {
  return (
    a.path.localeCompare(b.path) ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
