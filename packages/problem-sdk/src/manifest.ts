/**
 * [Problem SDK / Issue #2106 ← #2087] `tenkacloud-pack.json` manifest contract.
 *
 * This is the single source of truth for pack-manifest validation. The infra
 * copy (`infrastructure/lib/problem-pack/manifest.ts`) re-exports from here so
 * Core and external Pack authors validate against exactly one schema.
 *
 * The manifest is the ONLY entrypoint of a problem pack. This module owns the
 * schema, a pure deterministic parser, and validation diagnostics. It performs
 * NO I/O: it neither discovers problems nor installs / loads a pack, and it does
 * not touch the filesystem — so symlink resolution and the 1..200 problem-count
 * rule (which both need discovery) belong to the offline validator, not here.
 * Path fields are checked only as strings (absolute / `..` traversal).
 *
 * v1 is intentionally inert: there are no author credentials, remote URLs,
 * scripts, or executable hooks. `.strict()` enforces that by rejecting every
 * unknown top-level field.
 */

import { z } from "zod";
import { isExactSemver, isValidSemverRange } from "./semver-range.js";

/** Pack id: reverse-DNS style, lowercase, ≥2 dot-separated segments. */
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** The current pack manifest schema version. Authors pin `schemaVersion` to this. */
export const PACK_SCHEMA_VERSION = 1 as const;

/** The providers a pack may declare a required runtime for. */
export const PACK_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;

/**
 * Defense-in-depth bound on author-supplied version / range strings. A real
 * SemVer (or even a generous `||`-OR of comparators) is far shorter than this, so
 * the cap only ever rejects pathological input — and Zod applies `.max()` before
 * the `.refine()` validators, so over-long untrusted input is dropped before it
 * reaches any parsing at all.
 */
const MAX_VERSION_LENGTH = 256;

/**
 * A `(provider, engine)` capability the platform can satisfy or a pack requires.
 * Mirrors {@link ProviderEngineSchema} so the effective-catalog composer can
 * compare a manifest's `requiredRuntimes` against the platform without
 * re-deriving the shape.
 */
export interface ProviderEngineCapability {
  readonly provider: string;
  readonly engine: string;
}

/** True when a path string is absolute or escapes its root via `..`. */
function isUnsafeRelativePath(value: string): boolean {
  if (value.length === 0) return true;
  if (value.startsWith("/") || value.startsWith("\\")) return true; // POSIX / UNC absolute
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true; // Windows drive absolute
  return value.split(/[\\/]/).includes(".."); // traversal segment
}

const ProviderEngineSchema = z
  .object({
    provider: z.enum(PACK_PROVIDERS),
    engine: z.string().min(1, "engine must be a non-empty string"),
  })
  .strict();

const DependencySchema = z
  .object({
    id: z.string().regex(PACK_ID_PATTERN, "dependency id must be reverse-DNS style, lowercase"),
    range: z
      .string()
      .max(MAX_VERSION_LENGTH, "dependency range is too long")
      .refine(isValidSemverRange, "dependency range must be a valid SemVer range"),
  })
  .strict();

/** The `tenkacloud-pack.json` schema. `.strict()` rejects every unknown field. */
export const PackManifestSchema = z
  .object({
    schemaVersion: z.literal(PACK_SCHEMA_VERSION),
    id: z.string().regex(PACK_ID_PATTERN, "id must be reverse-DNS style, lowercase"),
    version: z
      .string()
      .max(MAX_VERSION_LENGTH, "version is too long")
      .refine(isExactSemver, "version must be a valid SemVer"),
    core: z
      .string()
      .max(MAX_VERSION_LENGTH, "core is too long")
      .refine(isValidSemverRange, "core must be a valid SemVer range"),
    title: z.string().min(1, "title must be a non-empty string"),
    description: z.string().min(1, "description must be a non-empty string"),
    license: z.string().min(1, "license must be a non-empty string"),
    problemsRoot: z
      .string()
      .refine(
        (value) => !isUnsafeRelativePath(value),
        "problemsRoot must be a relative path without '..' or an absolute root",
      ),
    requiredRuntimes: z.array(ProviderEngineSchema),
    dependencies: z.array(DependencySchema).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (!manifest.dependencies) return;
    const seen = new Set<string>();
    manifest.dependencies.forEach((dependency, index) => {
      if (seen.has(dependency.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate dependency id ${dependency.id}`,
          path: ["dependencies", index, "id"],
        });
      }
      seen.add(dependency.id);
    });
  });

/** A validated pack manifest. Inferred from the schema so the types cannot drift. */
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** One validation problem, with a JSON path (`a.b[0].c`) and a message. */
export interface PackManifestIssue {
  readonly path: string;
  readonly message: string;
}

/** The deterministic result of {@link parsePackManifest}. */
export type PackManifestParseResult =
  | { readonly ok: true; readonly manifest: PackManifest }
  | { readonly ok: false; readonly issues: readonly PackManifestIssue[] };

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc.length === 0 ? segment : `${acc}.${segment}`;
  }, "");
}

/**
 * Parse and validate an already-`JSON.parse`d manifest value. Pure and
 * deterministic: equal input always yields an equal result, with issues sorted
 * by path so diagnostics are stable. Never throws on invalid input — it returns
 * `{ ok: false, issues }` so the validator / CLI can render them.
 */
export function parsePackManifest(input: unknown): PackManifestParseResult {
  const result = PackManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  const issues = result.error.issues
    .flatMap((issue): PackManifestIssue[] => {
      // A rejected unknown field carries its key names in `keys`, not the path;
      // surface one issue per key so the diagnostic points at the offending field.
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          path: formatPath([...issue.path, key]),
          message: `unknown field '${key}' is not allowed`,
        }));
      }
      return [{ path: formatPath(issue.path), message: issue.message }];
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
  return { ok: false, issues };
}

// Issue #2224: the SemVer range engine now lives in semver-range.ts;
// re-exported here so existing imports of manifest.ts don't need to change.
export { satisfiesCoreRange } from "./semver-range.js";
