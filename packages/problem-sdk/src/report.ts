/**
 * [Problem SDK / Issue #2108] Deterministic pack-validation report.
 *
 * `buildPackReport(dir, options)` is the single function the reusable external
 * Pack CI workflow (`.github/workflows/problem-pack-ci.yml`) runs to produce a
 * machine-readable, byte-deterministic report of a pack's offline validation. It
 * is the report layer over the SDK's existing offline validator: it NEVER runs a
 * script from the pack, never touches the network, and never reads cloud
 * credentials. The only I/O is the read-only filesystem walk already performed by
 * {@link validatePackDirectory} plus the content-digest hash.
 *
 * The report is the public contract the workflow's outputs derive from:
 *   - `result` — `"passed"` | `"failed"` (the workflow's `result` output);
 *   - `packId` / `packVersion` — from the validated manifest (empty when the
 *     manifest did not parse);
 *   - `contentDigest` — a deterministic hex SHA-256 over the pack's file bytes,
 *     so equal content always yields an equal digest (the `content-digest`
 *     output);
 *   - `diagnostics` — the PUBLIC, namespaced `PACK_*` / `PROBLEM_*` / `RUNTIME_*`
 *     diagnostic codes shared with #2106 / #2107 (never the internal codes);
 *   - `ranLocalTests` — whether the offline harness phase ran (driven by the
 *     workflow's `run-local-tests` input). The harness here IS the deterministic
 *     SDK validation: there is deliberately no pack-supplied executable step.
 *
 * Determinism: given identical pack bytes the serialized report (see
 * {@link serializePackReport}) is byte-identical, independent of walk order, the
 * wall clock, or the host. That is what lets the workflow assert a stable report.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { toValidationDiagnostic, type ValidationDiagnostic } from "./diagnostics.js";
import { validatePackDirectory } from "./validate-pack.js";

/** The terminal outcome of a pack validation run. */
export type PackReportResult = "passed" | "failed";

/** The deterministic report {@link buildPackReport} produces. */
export interface PackReport {
  /** Stable report schema version. Bumped only on a breaking shape change. */
  readonly reportVersion: 1;
  /** `"passed"` when the pack validated with zero diagnostics, else `"failed"`. */
  readonly result: PackReportResult;
  /** Reverse-DNS pack id from the manifest; "" when the manifest did not parse. */
  readonly packId: string;
  /** Exact SemVer pack version from the manifest; "" when it did not parse. */
  readonly packVersion: string;
  /** Hex SHA-256 over the pack's canonical file list + bytes (deterministic). */
  readonly contentDigest: string;
  /** Discovered problem ids, sorted. Empty when discovery did not run. */
  readonly problemIds: readonly string[];
  /** Whether the offline harness (the SDK validation) phase ran. */
  readonly ranLocalTests: boolean;
  /** Public, namespaced diagnostics. Empty iff `result` is `"passed"`. */
  readonly diagnostics: readonly ValidationDiagnostic[];
}

/** Options for {@link buildPackReport}. */
export interface BuildPackReportOptions {
  /**
   * Run the local offline harness (the SDK's deterministic validation) when true
   * (default). The harness NEVER executes pack-supplied scripts — it is the same
   * read-only validation either way; this flag only records intent in the report.
   * Mirrors the reusable workflow's `run-local-tests` input.
   */
  readonly runLocalTests?: boolean;
}

/** Directory / file names excluded from the content digest (build / VCS noise). */
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", "dist"]);

/**
 * Build a deterministic validation report for a problem-pack directory.
 *
 * Pure-deterministic given the directory contents: it runs the offline SDK
 * validator, maps every internal diagnostic onto its public namespaced code, and
 * hashes the pack's bytes for the content digest. Never throws on a malformed
 * pack — every failure is a diagnostic and `result` becomes `"failed"`. Performs
 * NO network I/O, spawns NO process, and reads NO pack-supplied script.
 */
export function buildPackReport(dir: string, options: BuildPackReportOptions = {}): PackReport {
  const runLocalTests = options.runLocalTests ?? true;
  const validation = validatePackDirectory(dir);
  const diagnostics = validation.diagnostics.map(toValidationDiagnostic);
  return {
    reportVersion: 1,
    result: validation.ok ? "passed" : "failed",
    packId: validation.manifest?.id ?? "",
    packVersion: validation.manifest?.version ?? "",
    contentDigest: computeContentDigest(dir),
    problemIds: validation.problemIds,
    ranLocalTests: runLocalTests,
    diagnostics,
  };
}

/**
 * Serialize a report to a byte-deterministic JSON string (2-space indent, trailing
 * newline). Equal reports always serialize identically, so the workflow can write
 * the file and assert on it without ordering flakiness.
 */
export function serializePackReport(report: PackReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Compute a deterministic content digest of a pack directory: a hex SHA-256 over
 * a canonical encoding where every included file, in sorted POSIX-relative-path
 * order, contributes its length-prefixed path and its length-prefixed bytes. The
 * walk excludes `.git`, `node_modules`, `dist`, hidden (dot-prefixed) entries, and
 * symlinks (never followed or counted). Identical content always yields an
 * identical digest, independent of iteration order or timestamps.
 */
export function computeContentDigest(dir: string): string {
  const root = path.resolve(dir);
  if (!isExistingDirectory(root)) {
    // A missing pack directory has no bytes — hash the empty input so the result
    // is still deterministic rather than throwing.
    return createHash("sha256").digest("hex");
  }
  const files = collectFiles(root, root).sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relPath, "utf-8");
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    const content = fs.readFileSync(file.absPath);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** One included pack file: its pack-relative POSIX path and its absolute path. */
export interface CollectedPackFile {
  readonly relPath: string;
  readonly absPath: string;
}

/**
 * Walk a pack directory with the digest's exclusion rules (`.git` /
 * `node_modules` / `dist` / hidden entries / symlinks), unsorted. Exported (via
 * `/internal` only) for the Core snapshot installer, so the copied file set is
 * EXACTLY the digested file set — one walk implementation, no drift (#2866).
 */
export function collectPackFiles(dir: string): CollectedPackFile[] {
  const root = path.resolve(dir);
  return collectFiles(root, root);
}

function collectFiles(root: string, dir: string): CollectedPackFile[] {
  const out: CollectedPackFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isExcludedName(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(root, abs));
    } else if (entry.isFile()) {
      out.push({ relPath: toPosixRelative(root, abs), absPath: abs });
    }
  }
  return out;
}

function isExcludedName(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIR_NAMES.has(name);
}

function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
