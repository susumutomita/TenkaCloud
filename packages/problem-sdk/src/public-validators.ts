/**
 * [Problem SDK / Issue #2106] Public manifest validator + deterministic diagnostic
 * renderer.
 *
 * `validatePackManifest` is the public, namespaced wrapper over the pure
 * `parsePackManifest` (the single source of truth in `manifest.ts`). It returns
 * stable {@link ValidationDiagnostic}s instead of the internal parse result, so
 * external authoring tools depend only on the public contract.
 */

import type { ValidationDiagnostic } from "./diagnostics.js";
import { parsePackManifest } from "./manifest.js";

const MANIFEST_FILE = "tenkacloud-pack.json";

/**
 * Validate an already-`JSON.parse`d pack manifest. Returns an empty array when
 * valid; otherwise stable, namespaced diagnostics (`PACK_MANIFEST_INVALID`).
 * Pure and deterministic: equal input always yields equal output.
 */
export function validatePackManifest(input: unknown): readonly ValidationDiagnostic[] {
  const result = parsePackManifest(input);
  if (result.ok) return [];
  return result.issues.map((issue) => ({
    code: "PACK_MANIFEST_INVALID" as const,
    path: issue.path ? `${MANIFEST_FILE}:${issue.path}` : MANIFEST_FILE,
    message: issue.message,
  }));
}

/**
 * Render diagnostics deterministically as a multi-line string. Diagnostics are
 * sorted by (path, code, message) first, so equal input always renders to a
 * byte-identical string. Each line is `[CODE] path: message` with the optional
 * `hint` appended on its own indented line. An empty list renders to "".
 */
export function formatDiagnostics(diagnostics: readonly ValidationDiagnostic[]): string {
  const sorted = [...diagnostics].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  return sorted
    .map((diagnostic) => {
      const head = `[${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`;
      return diagnostic.hint ? `${head}\n    hint: ${diagnostic.hint}` : head;
    })
    .join("\n");
}
