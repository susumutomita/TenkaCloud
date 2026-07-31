/**
 * [Problem SDK / Issue #2224 ← #2184 RC-28-5] Self-contained SemVer range engine, extracted
 * verbatim from `manifest.ts` (which re-exports {@link satisfiesCoreRange} for backward
 * compatibility with existing callers).
 *
 * Pragmatic SemVer-range check (no `semver` dependency): comparators, caret/tilde ranges,
 * and hyphen ranges, `||`-OR of whitespace-AND clauses.
 */

/** Exact SemVer (`major.minor.patch` with optional pre-release / build). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** One comparator inside a range: optional operator + a (possibly wildcard) version. */
const COMPARATOR_PATTERN =
  /^(>=|<=|>|<|=|\^|~)?(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * A PLAIN (possibly wildcard / partial) version with NO operator prefix — the
 * only shape valid as a hyphen-range bound (`A - B`). `tokenBounds` turns an
 * operator-prefixed token into NaN, so we reject `>=1.2.3 - <2.0.0` at validation
 * time rather than silently matching nothing.
 */
const PLAIN_VERSION_PATTERN =
  /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function isExactSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/**
 * Pragmatic SemVer-range check (no `semver` dependency): every `||`-separated
 * clause must be either a `A - B` hyphen range or whitespace-separated
 * comparators, each matching {@link COMPARATOR_PATTERN}.
 */
export function isValidSemverRange(value: string): boolean {
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
    // Hyphen-range bounds must be PLAIN versions — a comparator prefix is invalid.
    return hyphen.every((bound) => PLAIN_VERSION_PATTERN.test(bound));
  }
  return normalized.split(" ").every((token) => COMPARATOR_PATTERN.test(token));
}

/**
 * A parsed exact SemVer: the three numeric core components plus the optional
 * dot-separated pre-release identifiers (build metadata is ignored per semver.org).
 */
interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifiers (`1.0.0-rc.1` → `["rc", "1"]`); empty for a release. */
  readonly prerelease: readonly string[];
}

/** Parse an exact `major.minor.patch[-prerelease][+build]` SemVer. Build is dropped. */
function parseExactSemver(value: string): SemverParts | undefined {
  if (!isExactSemver(value)) return undefined;
  const withoutBuild = value.split("+")[0] as string;
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleaseRaw = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const [major, minor, patch] = core.split(".").map((n) => Number.parseInt(n, 10)) as [
    number,
    number,
    number,
  ];
  const prerelease = prereleaseRaw.length > 0 ? prereleaseRaw.split(".") : [];
  return { major, minor, patch, prerelease };
}

/**
 * Compare two parsed SemVers per semver.org §11: numeric core first, then
 * pre-release precedence. A version with a pre-release has LOWER precedence than
 * the same version without one. Pre-release identifiers compare field-by-field:
 * numeric identifiers numerically, alphanumeric lexically, numeric < alphanumeric,
 * and a longer set of identifiers outranks a shorter prefix. Returns <0 / 0 / >0.
 */
function compareSemver(a: SemverParts, b: SemverParts): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // No pre-release outranks any pre-release; otherwise both have one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const cmp = comparePrereleaseIdentifier(a[i] as string, b[i] as string);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  if (aNumeric) return -1; // numeric identifiers have lower precedence than alphanumeric
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Construct a comparison boundary (range bounds never carry a pre-release tag). */
function bound(major: number, minor: number, patch: number): SemverParts {
  return { major, minor, patch, prerelease: [] };
}

/** Turn a (possibly wildcard / partial) version token into its bounds. */
function tokenBounds(token: string): { readonly lower: SemverParts; readonly upper: SemverParts } {
  const parts = token.split(".");
  const isWildcard = (s: string | undefined) =>
    s === undefined || s === "x" || s === "X" || s === "*";
  const major = isWildcard(parts[0]) ? undefined : Number.parseInt(parts[0], 10);
  const minor = isWildcard(parts[1]) ? undefined : Number.parseInt(parts[1], 10);
  const patch = isWildcard(parts[2]) ? undefined : Number.parseInt(parts[2], 10);
  const lower = bound(major ?? 0, minor ?? 0, patch ?? 0);
  if (major === undefined) {
    // `*` / `x` — any version.
    return { lower, upper: bound(Number.POSITIVE_INFINITY, 0, 0) };
  }
  if (minor === undefined) {
    return { lower, upper: bound(major + 1, 0, 0) };
  }
  if (patch === undefined) {
    return { lower, upper: bound(major, minor + 1, 0) };
  }
  return { lower, upper: bound(major, minor, patch + 1) };
}

/** Caret range upper bound: keep the leftmost non-zero component fixed. */
function caretUpper(v: SemverParts): SemverParts {
  if (v.major > 0) return bound(v.major + 1, 0, 0);
  if (v.minor > 0) return bound(0, v.minor + 1, 0);
  return bound(0, 0, v.patch + 1);
}

/** Tilde range upper bound: allow patch-level (or minor when no minor given). */
function tildeUpper(token: string, v: SemverParts): SemverParts {
  // `~1.2` and `~1.2.3` both bound at the next minor; `~1` bounds at next major.
  const segments = token.split(".").length;
  if (segments === 1) return bound(v.major + 1, 0, 0);
  return bound(v.major, v.minor + 1, 0);
}

/** Caret / tilde comparator: `[base, caretUpper|tildeUpper)`. */
function caretTildeSatisfied(op: "^" | "~", token: string, version: SemverParts): boolean {
  const base = tokenBounds(token).lower;
  const upper = op === "^" ? caretUpper(base) : tildeUpper(token, base);
  return compareSemver(version, base) >= 0 && compareSemver(version, upper) < 0;
}

/**
 * Inequality / equality comparator (`>` `>=` `<` `<=` `=` / bare). When the token
 * is a full exact version (with optional pre-release) compare against it directly
 * so pre-release precedence is honored; a wildcard / partial token (`1.x`, `1`)
 * has no exact form and falls back to its `[lower, upper)` interval.
 */
function inequalitySatisfied(op: string, token: string, version: SemverParts): boolean {
  const exact = parseExactSemver(token);
  const { lower, upper } = tokenBounds(token);
  switch (op) {
    case ">":
      return exact ? compareSemver(version, exact) > 0 : compareSemver(version, upper) >= 0;
    case ">=":
      return exact ? compareSemver(version, exact) >= 0 : compareSemver(version, lower) >= 0;
    case "<":
      return exact ? compareSemver(version, exact) < 0 : compareSemver(version, lower) < 0;
    case "<=":
      return exact ? compareSemver(version, exact) <= 0 : compareSemver(version, upper) < 0;
    default:
      // `=` or bare token: exact match compares equal; a wildcard / partial token
      // matches anything inside [lower, upper).
      return exact
        ? compareSemver(version, exact) === 0
        : compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
  }
}

/** Test one whitespace-separated comparator against a concrete version. */
function comparatorSatisfied(comparator: string, version: SemverParts): boolean {
  const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
  if (!match) return false;
  const op = match[1] ?? "";
  const token = match[2] as string;
  if (op === "^" || op === "~") return caretTildeSatisfied(op, token, version);
  return inequalitySatisfied(op, token, version);
}

/** Test a single AND-clause (a hyphen range or whitespace-joined comparators). */
function clauseSatisfied(clause: string, version: SemverParts): boolean {
  const normalized = normalizeWhitespace(clause);
  const hyphen = normalized.split(" - ");
  if (hyphen.length === 2) {
    const lower = tokenBounds(hyphen[0] as string).lower;
    const upper = tokenBounds(hyphen[1] as string).upper;
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
