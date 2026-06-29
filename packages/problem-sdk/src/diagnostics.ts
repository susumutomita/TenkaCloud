/**
 * [Problem SDK / Issue #2106] Diagnostic contracts.
 *
 * Two layers live here on purpose:
 *
 *  1. `PackDiagnostic` / `PackDiagnosticCode` — the INTERNAL pack-validator
 *     diagnostic the platform already shipped (#2088). `validatePackDirectory`
 *     returns these; the infra copy re-exports them so existing callers
 *     (pack-cli, snapshot) keep switching on the same code strings.
 *
 *  2. `ValidationDiagnostic` / `ValidationDiagnosticCode` — the PUBLIC, stable,
 *     NAMESPACED diagnostic contract for external Pack authors (#2106). Codes are
 *     namespaced `PACK_*` / `PROBLEM_*` / `RUNTIME_*` / `SCORING_*`. The error
 *     *string* is never the contract — authors switch on `code`.
 *
 * Every internal `PackDiagnosticCode` maps deterministically to one public
 * `ValidationDiagnosticCode` via {@link toValidationDiagnostic}, so the two never
 * drift and there is a single source of validation truth.
 */

/** Internal pack-validator diagnostic codes (#2088). Stable: callers switch on these. */
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

/** One internal author-facing diagnostic from the pack validator. */
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

/**
 * Public, stable, namespaced diagnostic codes (#2106). Additive in minor versions;
 * removing or repurposing a code is a major version change.
 */
export type ValidationDiagnosticCode =
  | "PACK_DIR_MISSING"
  | "PACK_MANIFEST_MISSING"
  | "PACK_MANIFEST_UNREADABLE"
  | "PACK_MANIFEST_INVALID"
  | "PACK_PROBLEMS_ROOT_MISSING"
  | "PACK_PROBLEMS_ROOT_TRAVERSAL"
  | "PACK_DUPLICATE_PROBLEM_ID"
  | "PACK_ARTIFACT_TRAVERSAL"
  | "PACK_ARTIFACT_MISSING"
  | "PROBLEM_METADATA_INVALID"
  | "RUNTIME_MISMATCH"
  | "RUNTIME_INVALID"
  | "RUNTIME_UNKNOWN_CAPABILITY"
  | "SCORING_INVALID";

/**
 * One public author-facing diagnostic. The `code` is the stable contract; `path`
 * locates the offending value (a file path, then a JSON path); `message` is human
 * remediation text; `hint` is an optional extra pointer.
 */
export interface ValidationDiagnostic {
  /** Stable, namespaced machine-readable code. */
  readonly code: ValidationDiagnosticCode;
  /** Location of the offending value (e.g. `tenkacloud-pack.json:id` or `metadata.json:scoring`). */
  readonly path: string;
  /** Actionable remediation message. */
  readonly message: string;
  /** Optional extra pointer (e.g. a doc reference or suggested fix). */
  readonly hint?: string;
}

/** Map an internal pack-validator code to its public namespaced equivalent. */
const PACK_CODE_TO_PUBLIC: Readonly<Record<PackDiagnosticCode, ValidationDiagnosticCode>> = {
  PACK_DIR_MISSING: "PACK_DIR_MISSING",
  MANIFEST_MISSING: "PACK_MANIFEST_MISSING",
  MANIFEST_UNREADABLE: "PACK_MANIFEST_UNREADABLE",
  MANIFEST_INVALID: "PACK_MANIFEST_INVALID",
  PROBLEMS_ROOT_MISSING: "PACK_PROBLEMS_ROOT_MISSING",
  PROBLEMS_ROOT_TRAVERSAL: "PACK_PROBLEMS_ROOT_TRAVERSAL",
  METADATA_INVALID: "PROBLEM_METADATA_INVALID",
  DUPLICATE_PROBLEM_ID: "PACK_DUPLICATE_PROBLEM_ID",
  ARTIFACT_TRAVERSAL: "PACK_ARTIFACT_TRAVERSAL",
  ARTIFACT_MISSING: "PACK_ARTIFACT_MISSING",
  RUNTIME_MISMATCH: "RUNTIME_MISMATCH",
};

/**
 * Convert an internal {@link PackDiagnostic} to the public, namespaced
 * {@link ValidationDiagnostic}. Deterministic: the same input always produces the
 * same output. The `path` joins the file and JSON path with `:` so a single
 * string locates the value.
 */
export function toValidationDiagnostic(diagnostic: PackDiagnostic): ValidationDiagnostic {
  const path = diagnostic.path ? `${diagnostic.file}:${diagnostic.path}` : diagnostic.file;
  return {
    code: PACK_CODE_TO_PUBLIC[diagnostic.code],
    path,
    message: diagnostic.message,
  };
}
