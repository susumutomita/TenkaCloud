/**
 * [Problem Packs / Issue #2087] `tenkacloud-pack.json` manifest contract.
 *
 * The manifest is the ONLY entrypoint of a problem pack. This module owns the
 * schema, a pure deterministic parser, and validation diagnostics. It performs
 * NO I/O: it neither discovers problems nor installs / loads a pack, and it does
 * not touch the filesystem — so symlink resolution and the 1..200 problem-count
 * rule (which both need discovery) belong to the offline validator (#2088), not
 * here. Path fields are checked only as strings (absolute / `..` traversal).
 *
 * v1 is intentionally inert: there are no author credentials, remote URLs,
 * scripts, or executable hooks. `.strict()` enforces that by rejecting every
 * unknown top-level field.
 */

import { z } from "zod";

/** Pack id: reverse-DNS style, lowercase, ≥2 dot-separated segments. */
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Exact SemVer (`major.minor.patch` with optional pre-release / build). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** One comparator inside a range: optional operator + a (possibly wildcard) version. */
const COMPARATOR_PATTERN =
  /^(>=|<=|>|<|=|\^|~)?(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** The providers a pack may declare a required runtime for (ADR-026 / ADR-027). */
export const PACK_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;

function isExactSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/**
 * Pragmatic SemVer-range check (no `semver` dependency): every `||`-separated
 * clause must be either a `A - B` hyphen range or whitespace-separated
 * comparators, each matching {@link COMPARATOR_PATTERN}.
 */
function isValidSemverRange(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return trimmed.split("||").every((clause) => isValidRangeClause(clause.trim()));
}

function isValidRangeClause(clause: string): boolean {
  if (clause.length === 0) return false;
  const hyphen = clause.split(/\s+-\s+/);
  if (hyphen.length === 2) {
    return hyphen.every((bound) => COMPARATOR_PATTERN.test(bound.trim()));
  }
  return clause.split(/\s+/).every((token) => COMPARATOR_PATTERN.test(token));
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
    range: z.string().refine(isValidSemverRange, "dependency range must be a valid SemVer range"),
  })
  .strict();

/** The `tenkacloud-pack.json` schema. `.strict()` rejects every unknown field. */
export const PackManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(PACK_ID_PATTERN, "id must be reverse-DNS style, lowercase"),
    version: z.string().refine(isExactSemver, "version must be a valid SemVer"),
    core: z.string().refine(isValidSemverRange, "core must be a valid SemVer range"),
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
 * `{ ok: false, issues }` so the validator / CLI (#2088) can render them.
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
