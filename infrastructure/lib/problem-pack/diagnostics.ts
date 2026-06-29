/**
 * [Problem Packs / Issue #2088] Shared diagnostic types for the pack validator.
 *
 * Kept in its own module so `validate-pack.ts` and its sibling validators
 * (`metadata-sections.ts`, etc.) can share the diagnostic contract without a
 * circular import.
 */

/** Stable diagnostic codes. Authors / tooling can switch on these. */
export type PackDiagnosticCode =
  | "PACK_DIR_MISSING"
  | "MANIFEST_MISSING"
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_INVALID"
  | "PROBLEMS_ROOT_MISSING"
  | "PROBLEMS_ROOT_TRAVERSAL"
  | "METADATA_INVALID"
  | "DUPLICATE_PROBLEM_ID"
  | "ARTIFACT_TRAVERSAL"
  | "ARTIFACT_MISSING"
  | "RUNTIME_MISMATCH";

/** One author-facing diagnostic. */
export interface PackDiagnostic {
  /** Stable machine-readable code. */
  readonly code: PackDiagnosticCode;
  /** Path relative to the pack dir of the offending file (or "." for the pack itself). */
  readonly file: string;
  /** JSON path inside `file` (`a.b[0].c`), or "" when not field-specific. */
  readonly path: string;
  /** Actionable remediation message. */
  readonly message: string;
}
