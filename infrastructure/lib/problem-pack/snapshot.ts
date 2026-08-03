/**
 * [Problem Packs / Issue #2090] Immutable local pack snapshots + lock file.
 *
 * The installer-internal store for a LOCAL pack source. It takes a validated
 * pack directory (validation is delegated to {@link validatePackDirectory} of
 * #2088 — only a pack that validates is ever snapshotted), copies its content
 * into an immutable snapshot tree, and records a lock entry describing what was
 * installed. There is NO catalog activation, NO network / Git source, and NO
 * runtime code execution here — those are deliberately deferred to later issues.
 *
 * Determinism + purity discipline:
 *   - {@link computeContentDigest} hashes a canonical, sorted file list and the
 *     bytes of each file. `.git`, `node_modules`, `dist`, hidden entries
 *     (dot-prefixed), and symlinks are excluded. Identical content always
 *     yields an identical digest, independent of walk order or wall-clock time.
 *   - `installedAt` and `coreVersion` are INJECTED by the caller (an explicit
 *     clock / version), never read from `Date.now()` or process state inside the
 *     core, so installs are reproducible and tests are deterministic.
 *
 * Immutability is enforced by the lock:
 *   - re-installing identical content (same packId+version+digest) is a no-op;
 *   - installing the SAME packId+version with a DIFFERENT digest FAILS CLOSED —
 *     an immutable revision must never silently change underneath consumers.
 *
 * Once installed, the snapshot is self-contained: the original source directory
 * may be deleted and the snapshot stays valid.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeContentDigest } from "@tenkacloud/problem-sdk";
import { collectPackFiles } from "@tenkacloud/problem-sdk/internal";
import { validatePackDirectory } from "./validate-pack.js";

/** The lock file at the root of a snapshot store. Records every installed pack. */
export const LOCK_FILENAME = "packs-lock.json";

/** Directory under the store root that holds the immutable snapshot trees. */
export const SNAPSHOTS_DIRNAME = "snapshots";

/**
 * Where an installed pack came from. `"local"` is a directory on disk (#2090);
 * `"git"` is a pinned, immutable Git revision fetched over HTTPS (#2097). No
 * other source kinds exist — there is no mutable / floating reference path.
 */
export type PackSourceKind = "local" | "git";

/**
 * Provenance of a pack installed from a pinned Git revision (#2097). Recorded in
 * the lock so an operator can reproduce exactly what was installed: the HTTPS
 * repository URL, the resolved immutable 40-hex commit, and the optional subdir
 * within the repository that held the pack. The content digest stays on the
 * parent {@link PackLockEntry} (same field as a local install) so digest
 * comparisons are source-kind-agnostic.
 */
export interface GitProvenance {
  /** The HTTPS repository URL the pack was fetched from (credentials stripped). */
  readonly repositoryUrl: string;
  /** The resolved immutable commit (full 40-hex SHA-1). Never a floating ref. */
  readonly commit: string;
  /** Subdir within the repository that held the pack root (POSIX, "" for root). */
  readonly subdir: string;
}

/** One immutable lock entry describing an installed pack snapshot. */
export interface PackLockEntry {
  /** Reverse-DNS pack id, from the validated manifest. */
  readonly packId: string;
  /** Exact SemVer of the pack, from the validated manifest. */
  readonly version: string;
  /** Where the pack came from (`"local"` or `"git"`). */
  readonly sourceKind: PackSourceKind;
  /** Caller-supplied reference to the source (e.g. the original directory path). */
  readonly sourceRef: string;
  /** Hex SHA-256 over the canonical file list + bytes (see {@link computeContentDigest}). */
  readonly contentDigest: string;
  /** Caller-injected install timestamp (ISO-8601). Never read from the clock here. */
  readonly installedAt: string;
  /** Caller-injected core (platform) version this pack was installed against. */
  readonly coreVersion: string;
  /** Store-root-relative path to the immutable snapshot tree. */
  readonly snapshotPath: string;
  /** Git provenance — present iff `sourceKind === "git"`. Absent for local installs. */
  readonly git?: GitProvenance;
}

/** The lock file shape: a stable-sorted list of entries plus a schema version. */
export interface PackLockFile {
  readonly schemaVersion: 1;
  readonly packs: readonly PackLockEntry[];
}

/**
 * On-disk lock entry as it may appear in a LEGACY lock (written before #2097
 * introduced `sourceKind`). `sourceKind` is optional here; {@link readLock}
 * backfills it to `"local"` so the in-memory {@link PackLockEntry} always has it.
 */
type LegacyLockEntry = Omit<PackLockEntry, "sourceKind"> & {
  readonly sourceKind?: PackSourceKind;
};

/** Options for {@link installLocalPack}. */
export interface InstallLocalPackOptions {
  /** Directory containing the validated pack (must hold `tenkacloud-pack.json`). */
  readonly sourceDir: string;
  /** Root of the snapshot store (lock file + snapshots/ live under here). */
  readonly storeDir: string;
  /** Reference recorded as `sourceRef`. Defaults to the resolved `sourceDir`. */
  readonly sourceRef?: string;
  /** Caller-injected install timestamp (ISO-8601). Keeps the core deterministic. */
  readonly installedAt: string;
  /** Caller-injected core (platform) version. */
  readonly coreVersion: string;
}

/** Fields common to every {@link InstallSnapshotOptions} variant. */
interface InstallSnapshotBase {
  /** Directory containing the validated pack (must hold `tenkacloud-pack.json`). */
  readonly sourceDir: string;
  /** Root of the snapshot store (lock file + snapshots/ live under here). */
  readonly storeDir: string;
  /** Reference recorded as `sourceRef`. Defaults to the resolved `sourceDir`. */
  readonly sourceRef?: string;
  /** Caller-injected install timestamp (ISO-8601). Keeps the core deterministic. */
  readonly installedAt: string;
  /** Caller-injected core (platform) version. */
  readonly coreVersion: string;
}

/**
 * Options for {@link installSnapshotFromDirectory} — the source-kind-agnostic
 * snapshot core shared by the local (#2090) and Git (#2097) install paths. The
 * caller has already materialized the pack into `sourceDir` (a real directory on
 * disk; for Git that is the extracted temporary tree).
 *
 * A DISCRIMINATED UNION on `sourceKind` makes provenance type-safe: a `"git"`
 * install REQUIRES `git` provenance, and a `"local"` install FORBIDS it (`never`),
 * so a malformed entry (git without provenance, or local with stray provenance)
 * cannot be constructed.
 */
export type InstallSnapshotOptions =
  | (InstallSnapshotBase & { readonly sourceKind: "local"; readonly git?: never })
  | (InstallSnapshotBase & { readonly sourceKind: "git"; readonly git: GitProvenance });

/** Discriminated result of {@link installLocalPack}. Never throws on a known failure. */
export type InstallLocalPackResult =
  | {
      readonly ok: true;
      /** The lock entry for this pack (newly created or the pre-existing identical one). */
      readonly entry: PackLockEntry;
      /** True when the identical content was already installed (no filesystem change). */
      readonly alreadyInstalled: boolean;
    }
  | {
      readonly ok: false;
      /** Stable failure reason. */
      readonly reason: InstallFailureReason;
      /** Human-readable explanation. */
      readonly message: string;
    };

/** Stable failure reasons so callers / CLIs can switch on the outcome. */
export type InstallFailureReason = "INVALID_PACK" | "DIGEST_CONFLICT";

// [#2866] The digest + file walk moved to `@tenkacloud/problem-sdk` (report.ts) —
// it was a verbatim clone. The SDK version is byte-identical for an existing
// directory (same canonical encoding, same exclusions), and additionally
// hashes empty input instead of throwing for a missing one (unreachable here:
// every caller digests a directory that just validated). Re-exported so
// existing `from "./snapshot.js"` import sites are unchanged.
export { computeContentDigest };

/**
 * Install a validated local pack into the snapshot store and update the lock.
 *
 * Steps: validate the source (reuse #2088) → compute the content digest →
 * reconcile against the lock (idempotent on identical digest, fail-closed on a
 * conflicting same id+version) → copy the included files into an immutable
 * snapshot tree → append the lock entry. Performs only local filesystem I/O.
 */
export function installLocalPack(options: InstallLocalPackOptions): InstallLocalPackResult {
  return installSnapshotFromDirectory({
    sourceDir: options.sourceDir,
    storeDir: options.storeDir,
    sourceKind: "local",
    sourceRef: options.sourceRef,
    installedAt: options.installedAt,
    coreVersion: options.coreVersion,
  });
}

/**
 * Source-kind-agnostic snapshot core shared by the local (#2090) and Git (#2097)
 * install paths. The pack has already been materialized into `sourceDir`; this
 * function validates → digests → reconciles against the lock (idempotent on an
 * identical digest, fail-closed on a conflicting same id+version) → copies the
 * included files into an immutable snapshot tree → appends the lock entry, with
 * the caller-supplied provenance (`sourceKind` and optional `git`). Performs only
 * local filesystem I/O; it never spawns a process and never fetches anything.
 */
export function installSnapshotFromDirectory(
  options: InstallSnapshotOptions,
): InstallLocalPackResult {
  const sourceDir = path.resolve(options.sourceDir);
  const storeDir = path.resolve(options.storeDir);

  const validation = validatePackDirectory(sourceDir);
  if (!validation.ok || !validation.manifest) {
    return {
      ok: false,
      reason: "INVALID_PACK",
      message: `Refusing to snapshot an invalid pack at '${options.sourceDir}': ${validation.diagnostics.length} diagnostic(s). Fix validation errors before installing.`,
    };
  }

  const { id: packId, version } = validation.manifest;
  const contentDigest = computeContentDigest(sourceDir);
  const lock = readLock(storeDir);

  const existing = lock.packs.find((p) => p.packId === packId && p.version === version);
  if (existing) {
    if (existing.contentDigest === contentDigest) {
      // Same id+version+digest → identical content already installed: no-op.
      return { ok: true, entry: existing, alreadyInstalled: true };
    }
    return {
      ok: false,
      reason: "DIGEST_CONFLICT",
      message: `Pack '${packId}' version '${version}' is already installed with digest ${existing.contentDigest}, but the source has digest ${contentDigest}. An immutable revision cannot change — bump the version to install new content.`,
    };
  }

  const snapshotPath = path.posix.join(SNAPSHOTS_DIRNAME, packId, version);
  const snapshotAbs = path.join(storeDir, SNAPSHOTS_DIRNAME, packId, version);
  copySnapshot(sourceDir, snapshotAbs);

  const entry: PackLockEntry = {
    packId,
    version,
    sourceKind: options.sourceKind,
    sourceRef: options.sourceRef ?? sourceDir,
    contentDigest,
    installedAt: options.installedAt,
    coreVersion: options.coreVersion,
    snapshotPath,
    // Key provenance off `sourceKind`: only a Git install carries `git` (the
    // discriminated union guarantees it is present there and absent for local),
    // so a malformed `git` field can never be written.
    ...(options.sourceKind === "git" ? { git: options.git } : {}),
  };
  writeLock(storeDir, { schemaVersion: 1, packs: [...lock.packs, entry] });
  return { ok: true, entry, alreadyInstalled: false };
}

/** Read the lock file, returning an empty lock when the store is new. */
export function readLock(storeDir: string): PackLockFile {
  const lockPath = path.join(path.resolve(storeDir), LOCK_FILENAME);
  if (!fs.existsSync(lockPath)) {
    return { schemaVersion: 1, packs: [] };
  }
  // Legacy lock entries (written before #2097 added `sourceKind`) may omit it, so
  // parse with a relaxed entry type and backfill on read.
  const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
    packs?: readonly LegacyLockEntry[];
  };
  // Default-then-spread so an explicit value (e.g. "git") always wins over "local".
  const packs: PackLockEntry[] = (parsed.packs ?? []).map((entry) => ({
    sourceKind: "local" as const,
    ...entry,
  }));
  return { schemaVersion: 1, packs };
}

/**
 * Write the lock file in canonical, byte-deterministic form (entries sorted by
 * packId then version). Exported so the lifecycle engine (#2094) reuses the same
 * writer for rollback / removal instead of re-deriving the on-disk format.
 */
export function writeLock(storeDir: string, lock: PackLockFile): void {
  const resolved = path.resolve(storeDir);
  fs.mkdirSync(resolved, { recursive: true });
  // Stable order: by packId then version, so the lock is byte-deterministic.
  const packs = [...lock.packs].sort(
    (a, b) => a.packId.localeCompare(b.packId) || a.version.localeCompare(b.version),
  );
  const lockPath = path.join(resolved, LOCK_FILENAME);
  fs.writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, packs }, null, 2)}\n`);
}

/**
 * Copy the included files of `sourceDir` into `destDir`, applying the same
 * exclusions as the digest (no `.git` / `node_modules` / `dist`, no hidden
 * entries, no symlinks). The snapshot is thus self-contained and immutable: it
 * depends on nothing outside `destDir` and survives deletion of the source.
 */
function copySnapshot(sourceDir: string, destDir: string): void {
  for (const file of collectPackFiles(sourceDir)) {
    const target = path.join(destDir, ...file.relPath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absPath, target);
  }
}
