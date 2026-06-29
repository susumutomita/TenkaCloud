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

/** Pack id: reverse-DNS style, lowercase, ≥2 dot-separated segments. */
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Exact SemVer (`major.minor.patch` with optional pre-release / build). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** One comparator inside a range: optional operator + a (possibly wildcard) version. */
const COMPARATOR_PATTERN =
  /^(>=|<=|>|<|=|\^|~)?(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** The current pack manifest schema version. Authors pin `schemaVersion` to this. */
export const PACK_SCHEMA_VERSION = 1 as const;

/** The providers a pack may declare a required runtime for (ADR-026 / ADR-027). */
export const PACK_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;

/**
 * Defense-in-depth bound on author-supplied version / range strings. A real
 * SemVer (or even a generous `||`-OR of comparators) is far shorter than this, so
 * the cap only ever rejects pathological input — and Zod applies `.max()` before
 * the `.refine()` validators, so over-long untrusted input is dropped before it
 * reaches any parsing at all.
 */
const MAX_VERSION_LENGTH = 256;

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

/**
 * Collapse runs of whitespace to a single space and trim. ReDoS-safe: a single
 * global `\s+` replace is linear, so callers can then split on a literal `" - "`
 * / `" "` instead of the polynomial `\s+-\s+` / `\s+` split patterns (which retry
 * their adjacent unbounded quantifiers at every position on attacker-supplied
 * input). Semantics are preserved — `\s` still covers spaces, tabs, and newlines.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isValidRangeClause(clause: string): boolean {
  const normalized = normalizeWhitespace(clause);
  if (normalized.length === 0) return false;
  const hyphen = normalized.split(" - ");
  if (hyphen.length === 2) {
    return hyphen.every((bound) => COMPARATOR_PATTERN.test(bound));
  }
  return normalized.split(" ").every((token) => COMPARATOR_PATTERN.test(token));
}

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

/** A parsed exact SemVer split into its three numeric core components. */
interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse an exact `major.minor.patch` SemVer, ignoring pre-release / build. */
function parseExactSemver(value: string): SemverParts | undefined {
  if (!isExactSemver(value)) return undefined;
  const core = value.split("+")[0].split("-")[0];
  const [major, minor, patch] = core.split(".").map((n) => Number.parseInt(n, 10));
  return { major, minor, patch };
}

/** Numeric comparison of two parsed SemVers: -1 / 0 / 1. Ignores pre-release. */
function compareSemver(a: SemverParts, b: SemverParts): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Turn a (possibly wildcard / partial) version token into its bounds. */
function tokenBounds(token: string): { readonly lower: SemverParts; readonly upper: SemverParts } {
  const parts = token.split(".");
  const isWildcard = (s: string | undefined) =>
    s === undefined || s === "x" || s === "X" || s === "*";
  const major = isWildcard(parts[0]) ? undefined : Number.parseInt(parts[0], 10);
  const minor = isWildcard(parts[1]) ? undefined : Number.parseInt(parts[1], 10);
  const patch = isWildcard(parts[2]) ? undefined : Number.parseInt(parts[2], 10);
  const lower: SemverParts = { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 };
  if (major === undefined) {
    // `*` / `x` — any version.
    return { lower, upper: { major: Number.POSITIVE_INFINITY, minor: 0, patch: 0 } };
  }
  if (minor === undefined) {
    return { lower, upper: { major: major + 1, minor: 0, patch: 0 } };
  }
  if (patch === undefined) {
    return { lower, upper: { major, minor: minor + 1, patch: 0 } };
  }
  return { lower, upper: { major, minor, patch: patch + 1 } };
}

/** Caret range upper bound: keep the leftmost non-zero component fixed. */
function caretUpper(v: SemverParts): SemverParts {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0 };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: v.patch + 1 };
}

/** Tilde range upper bound: allow patch-level (or minor when no minor given). */
function tildeUpper(token: string, v: SemverParts): SemverParts {
  // `~1.2` and `~1.2.3` both bound at the next minor; `~1` bounds at next major.
  const segments = token.split(".").length;
  if (segments === 1) return { major: v.major + 1, minor: 0, patch: 0 };
  return { major: v.major, minor: v.minor + 1, patch: 0 };
}

/** Test one whitespace-separated comparator against a concrete version. */
function comparatorSatisfied(comparator: string, version: SemverParts): boolean {
  const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
  if (!match) return false;
  const op = match[1] ?? "";
  const token = match[2];
  if (op === "^") {
    const base = tokenBounds(token).lower;
    return compareSemver(version, base) >= 0 && compareSemver(version, caretUpper(base)) < 0;
  }
  if (op === "~") {
    const base = tokenBounds(token).lower;
    return compareSemver(version, base) >= 0 && compareSemver(version, tildeUpper(token, base)) < 0;
  }
  const { lower, upper } = tokenBounds(token);
  switch (op) {
    case ">":
      return compareSemver(version, upper) >= 0;
    case ">=":
      return compareSemver(version, lower) >= 0;
    case "<":
      return compareSemver(version, lower) < 0;
    case "<=":
      return compareSemver(version, upper) < 0;
    default:
      // `=` or bare token: an exact / wildcard match falls within [lower, upper).
      return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
  }
}

/** Test a single AND-clause (a hyphen range or whitespace-joined comparators). */
function clauseSatisfied(clause: string, version: SemverParts): boolean {
  const normalized = normalizeWhitespace(clause);
  const hyphen = normalized.split(" - ");
  if (hyphen.length === 2) {
    const lower = tokenBounds(hyphen[0]).lower;
    const upper = tokenBounds(hyphen[1]).upper;
    return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
  }
  return normalized.split(" ").every((comparator) => comparatorSatisfied(comparator, version));
}

/**
 * Test whether an exact SemVer satisfies a (manifest-validated) SemVer range.
 *
 * Pure and dependency-free (no `semver` package — see {@link isValidSemverRange}
 * for the same pragmatic grammar). The range is the `||`-OR of clauses; each
 * clause is the whitespace-AND of comparators (`^`, `~`, `>=`, `<=`, `>`, `<`,
 * `=`, bare / wildcard) or a `A - B` hyphen range. An invalid version or range
 * returns false rather than throwing, so the composer can fail closed.
 */
export function satisfiesCoreRange(version: string, range: string): boolean {
  const parsed = parseExactSemver(version);
  if (!parsed) return false;
  if (!isValidSemverRange(range)) return false;
  return range
    .trim()
    .split("||")
    .some((clause) => clauseSatisfied(clause.trim(), parsed));
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
