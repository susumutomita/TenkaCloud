/**
 * [Problem Packs / Issue #2094] Local pack lifecycle engine.
 *
 * The offline core behind the `pack install|list|inspect|remove` CLI. It composes
 * the upstream building blocks — #2088 {@link validatePackDirectory}, #2090
 * {@link installLocalPack} (snapshot + lock), and #2091
 * {@link composeEffectiveCatalog} — into the four user-facing operations, with NO
 * cloud / remote calls and only local filesystem I/O.
 *
 * Discipline carried over from the dependencies:
 *   - `installedAt` / `coreVersion` and the available platform runtimes are
 *     INJECTED by the caller, never read from the clock / process state here, so
 *     installs are reproducible and tests are deterministic.
 *   - `installPack` is ATOMIC: an invalid pack is rejected by the validator
 *     before any write (#2090), and a dry-run compose conflict — a pack whose
 *     problem ids would clash with already-installed packs, or whose required
 *     runtime is unavailable — rolls the just-written snapshot + lock entry back
 *     so no partial residue survives. There is NO catalog activation: the compose
 *     is a dry run that only proves the pack COULD be activated without conflict.
 *   - `list` / `inspect` read ONLY the local lock and snapshot metadata and NEVER
 *     surface snapshot filesystem paths (the `snapshotPath` lock field is internal).
 *   - `remove` is REFUSED when the injected pin predicate reports the revision is
 *     referenced by an event / deployment / activation; otherwise it deletes the
 *     snapshot tree and the lock entry atomically.
 *
 * There is deliberately NO `update` command in v1: a new version is a separate
 * `install`, preserving the immutable-revision guarantee of the snapshot store.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ComposeEffectiveCatalogResult,
  composeEffectiveCatalog,
  type PackProblemInput,
  type PackSnapshotInput,
} from "./effective-catalog.js";
import {
  type PackManifest,
  type ProviderEngineCapability,
  satisfiesCoreRange,
} from "./manifest.js";
import {
  installLocalPack,
  type PackLockEntry,
  type PackSourceKind,
  readLock,
  SNAPSHOTS_DIRNAME,
  writeLock,
} from "./snapshot.js";
import { validatePackDirectory } from "./validate-pack.js";

/**
 * Git source install (#2097). Re-exported from {@link ./git-source.js} so the CLI
 * reaches every install path through this lifecycle module, exactly as it does
 * for the local {@link installPack}. The implementation lives in `git-source.ts`
 * because it owns the network transport boundary and its injectable fetcher.
 */
export { installGitPack } from "./git-source.js";

/** Options for {@link installPack}. */
export interface InstallPackOptions {
  /** Directory containing the pack to install (must hold `tenkacloud-pack.json`). */
  readonly sourceDir: string;
  /** Root of the snapshot store (lock file + snapshots/ live under here). */
  readonly storeDir: string;
  /** Caller-injected install timestamp (ISO-8601). Keeps the engine deterministic. */
  readonly installedAt: string;
  /** Caller-injected core (platform) version the pack is installed against. */
  readonly coreVersion: string;
  /** Provider/engine capabilities the platform can satisfy (for the dry-run compose). */
  readonly availableRuntimes: readonly ProviderEngineCapability[];
}

/** Stable failure reasons so callers / CLIs can switch on the outcome. */
export type InstallPackFailureReason = "INVALID_PACK" | "DIGEST_CONFLICT" | "COMPOSE_CONFLICT";

/** Discriminated result of {@link installPack}. Never throws on a known failure. */
export type InstallPackResult =
  | {
      readonly ok: true;
      /** The lock entry for this pack (newly created or the pre-existing identical one). */
      readonly entry: PackLockEntry;
      /** True when the identical content was already installed (no filesystem change). */
      readonly alreadyInstalled: boolean;
      /** Number of problems discovered in the installed pack. */
      readonly problemCount: number;
    }
  | {
      readonly ok: false;
      readonly reason: InstallPackFailureReason;
      readonly message: string;
    };

/**
 * Install a local pack: validate (#2088) → snapshot + lock (#2090) → dry-run
 * compose the effective catalog (#2091) to prove the pack adds no duplicate id
 * and its runtimes are available. The compose is a DRY RUN — it does NOT activate
 * the catalog. If the compose fails, the just-written snapshot + lock entry are
 * rolled back so an unusable pack leaves no residue. Re-installing identical
 * content is idempotent; the same id+version with a different digest fails closed.
 */
export function installPack(options: InstallPackOptions): InstallPackResult {
  const storeDir = path.resolve(options.storeDir);
  const lockBefore = readLock(storeDir);

  const installed = installLocalPack({
    sourceDir: options.sourceDir,
    storeDir,
    installedAt: options.installedAt,
    coreVersion: options.coreVersion,
  });
  if (!installed.ok) {
    return { ok: false, reason: installed.reason, message: installed.message };
  }

  // Re-installing identical content changed nothing; no need to re-compose.
  if (installed.alreadyInstalled) {
    const problems = loadSnapshotProblems(storeDir, installed.entry);
    return {
      ok: true,
      entry: installed.entry,
      alreadyInstalled: true,
      problemCount: problems.length,
    };
  }

  const newProblems = loadSnapshotProblems(storeDir, installed.entry);
  const compose = dryRunCompose(storeDir, options);
  if (!compose.ok) {
    // Atomic rollback: drop the just-added snapshot tree + lock entry.
    rollbackInstall(storeDir, lockBefore, installed.entry);
    return {
      ok: false,
      reason: "COMPOSE_CONFLICT",
      message: compose.message,
    };
  }

  return {
    ok: true,
    entry: installed.entry,
    alreadyInstalled: false,
    problemCount: newProblems.length,
  };
}

/** Public summary of one installed pack. Carries NO snapshot filesystem path. */
export interface InstalledPackSummary {
  readonly packId: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly sourceKind: PackSourceKind;
  readonly problemCount: number;
}

/**
 * List the installed packs from the local lock + snapshot metadata. Reads ONLY
 * the lock and the snapshot trees it references; the result intentionally omits
 * the `snapshotPath` so no filesystem path is ever surfaced. Stable-sorted by
 * packId then version so automation output is deterministic.
 */
export function listInstalledPacks(storeDir: string): readonly InstalledPackSummary[] {
  const resolved = path.resolve(storeDir);
  return [...readLock(resolved).packs]
    .sort((a, b) => a.packId.localeCompare(b.packId) || a.version.localeCompare(b.version))
    .map((entry) => ({
      packId: entry.packId,
      version: entry.version,
      contentDigest: entry.contentDigest,
      sourceKind: entry.sourceKind,
      problemCount: loadSnapshotProblems(resolved, entry).length,
    }));
}

/** One declared dependency with its resolved status against the local store. */
export interface DependencyStatus {
  readonly id: string;
  readonly range: string;
  /** True when a pack with `id` and a version satisfying `range` is installed. */
  readonly satisfied: boolean;
}

/** Full inspection of one installed pack. Carries NO snapshot filesystem path. */
export interface PackInspection {
  readonly packId: string;
  readonly version: string;
  readonly contentDigest: string;
  readonly sourceKind: PackSourceKind;
  /** The manifest's `core` SemVer range. */
  readonly core: string;
  /** The manifest's declared required runtimes. */
  readonly requiredRuntimes: readonly ProviderEngineCapability[];
  /** Problem ids discovered in the immutable snapshot, sorted. */
  readonly problemIds: readonly string[];
  /** Declared dependencies with their resolution status against the local store. */
  readonly dependencies: readonly DependencyStatus[];
}

/**
 * Inspect one installed pack revision. Reads the manifest + problem ids from the
 * immutable snapshot and resolves each declared dependency against the local lock.
 * Returns undefined when the revision is not installed. Never exposes a snapshot
 * filesystem path.
 */
export function inspectPack(
  storeDir: string,
  packId: string,
  version: string,
): PackInspection | undefined {
  const resolved = path.resolve(storeDir);
  const lock = readLock(resolved);
  const entry = lock.packs.find((p) => p.packId === packId && p.version === version);
  if (!entry) return undefined;

  const manifest = readSnapshotManifest(resolved, entry);
  const problems = loadSnapshotProblems(resolved, entry);
  const installedIds = lock.packs.map((p) => ({ id: p.packId, version: p.version }));
  return {
    packId: entry.packId,
    version: entry.version,
    contentDigest: entry.contentDigest,
    sourceKind: entry.sourceKind,
    core: manifest?.core ?? "",
    requiredRuntimes: manifest?.requiredRuntimes ?? [],
    problemIds: problems.map((p) => p.problemId).sort((a, b) => a.localeCompare(b)),
    dependencies: (manifest?.dependencies ?? []).map((dependency) => ({
      id: dependency.id,
      range: dependency.range,
      satisfied: installedIds.some(
        (installed) =>
          installed.id === dependency.id && satisfiesCoreRange(installed.version, dependency.range),
      ),
    })),
  };
}

/**
 * Predicate deciding whether a revision is pinned (referenced by an event,
 * deployment, or activation) and therefore must not be removed. Injected so the
 * pin source stays out of this offline engine.
 */
export type PinPredicate = (entry: PackLockEntry) => boolean;

/** Stable failure reasons for {@link removePack}. */
export type RemovePackFailureReason = "NOT_FOUND" | "PINNED";

/** Discriminated result of {@link removePack}. Never throws. */
export type RemovePackResult =
  | { readonly ok: true; readonly removed: PackLockEntry }
  | { readonly ok: false; readonly reason: RemovePackFailureReason; readonly message: string };

/**
 * Remove an installed pack revision: the snapshot tree and the lock entry are
 * deleted together. REFUSED (without touching anything) when `isPinned` reports
 * the revision is referenced by an event / deployment / activation. Returns
 * NOT_FOUND when the revision is not installed.
 */
export function removePack(
  storeDir: string,
  packId: string,
  version: string,
  isPinned: PinPredicate,
): RemovePackResult {
  const resolved = path.resolve(storeDir);
  const lock = readLock(resolved);
  const entry = lock.packs.find((p) => p.packId === packId && p.version === version);
  if (!entry) {
    return {
      ok: false,
      reason: "NOT_FOUND",
      message: `Pack '${packId}@${version}' is not installed.`,
    };
  }
  if (isPinned(entry)) {
    return {
      ok: false,
      reason: "PINNED",
      message: `Pack '${packId}@${version}' is pinned by an event, deployment, or activation and cannot be removed. Remove the reference first.`,
    };
  }

  // Delete the snapshot tree, then the lock entry. Pruning empty parent dirs keeps
  // the store tidy without ever touching another revision's snapshot.
  removeSnapshotTree(resolved, entry);
  writeLock(resolved, {
    schemaVersion: 1,
    packs: lock.packs.filter((p) => !(p.packId === packId && p.version === version)),
  });
  return { ok: true, removed: entry };
}

/** Compose the effective catalog over EVERY installed pack as a dry run. */
function dryRunCompose(
  storeDir: string,
  options: InstallPackOptions,
): ComposeEffectiveCatalogResult {
  const lock = readLock(storeDir);
  const packs: PackSnapshotInput[] = [];
  for (const entry of lock.packs) {
    const manifest = readSnapshotManifest(storeDir, entry);
    if (!manifest) continue;
    packs.push({
      manifest,
      contentDigest: entry.contentDigest,
      problems: loadSnapshotProblems(storeDir, entry),
    });
  }
  return composeEffectiveCatalog({
    core: [],
    packs,
    platform: {
      coreVersion: options.coreVersion,
      availableRuntimes: options.availableRuntimes,
    },
  });
}

/** Read + parse the manifest from a pack's immutable snapshot tree. */
function readSnapshotManifest(storeDir: string, entry: PackLockEntry): PackManifest | undefined {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  const validation = validatePackDirectory(snapshotAbs);
  return validation.manifest;
}

/**
 * Load the problems contributed by a pack's immutable snapshot as compose inputs.
 * Reuses the #2088 validator's discovery so it stays in lockstep with what
 * validates; projections are empty because the dry-run compose only needs ids for
 * duplicate detection (activation is a later issue's concern).
 */
function loadSnapshotProblems(storeDir: string, entry: PackLockEntry): PackProblemInput[] {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  const validation = validatePackDirectory(snapshotAbs);
  const root = validation.manifest?.problemsRoot ?? "problems";
  return validation.problemIds.map((problemId) => ({
    problemId,
    directory: root,
    projections: {},
  }));
}

/** Roll a just-installed pack back: delete its snapshot tree, restore the lock. */
function rollbackInstall(
  storeDir: string,
  lockBefore: ReturnType<typeof readLock>,
  entry: PackLockEntry,
): void {
  removeSnapshotTree(storeDir, entry);
  // Restore the pre-install lock exactly. If it had no packs, drop the lock file
  // so a failed first install leaves the store as pristine as it found it.
  if (lockBefore.packs.length === 0) {
    const lockPath = path.join(storeDir, "packs-lock.json");
    if (fs.existsSync(lockPath)) fs.rmSync(lockPath);
  } else {
    writeLock(storeDir, lockBefore);
  }
  pruneEmptyDir(path.join(storeDir, SNAPSHOTS_DIRNAME));
}

/** Delete a pack revision's snapshot tree and prune now-empty parent dirs. */
function removeSnapshotTree(storeDir: string, entry: PackLockEntry): void {
  const snapshotAbs = path.join(storeDir, entry.snapshotPath);
  if (fs.existsSync(snapshotAbs)) {
    fs.rmSync(snapshotAbs, { recursive: true, force: true });
  }
  // Prune the now-possibly-empty packId directory, then the snapshots root.
  pruneEmptyDir(path.dirname(snapshotAbs));
  pruneEmptyDir(path.join(storeDir, SNAPSHOTS_DIRNAME));
}

/** Remove a directory only when it exists and is empty. Best-effort, never throws. */
function pruneEmptyDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}
