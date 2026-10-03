/**
 * [Problem Packs / Issue #2091] Pure effective-catalog composer.
 *
 * `composeEffectiveCatalog` merges the built-in (core) problem catalog with the
 * problems contributed by already-validated installed pack snapshots into one
 * effective catalog. Every resulting entry retains its provenance — whether it
 * came from core or from a specific pack (packId / packVersion / contentDigest).
 *
 * Purity discipline (this is the whole point of the module):
 *   - NO filesystem or network I/O. The composer receives ALREADY-LOADED core
 *     problems and ALREADY-VALIDATED snapshot inputs; discovery (#2086 core
 *     discovery, #2088 validation, #2090 snapshot install) happens upstream.
 *   - Deterministic: equal input always yields an equal effective catalog, with
 *     a stable order (core first in its given order, then packs by
 *     packId / packVersion / problemId).
 *
 * Fail-closed rules (a conflict is never silently resolved):
 *   - a problem id duplicated across ANY two sources fails, naming BOTH source
 *     identities — there is no "last writer wins";
 *   - installed packs CANNOT override a core problem in v1 — a pack id that
 *     collides with a core id is reported as a core/pack conflict;
 *   - before a pack's problems are merged, the manifest's `core` SemVer range
 *     must be satisfied by the platform core version, and every declared
 *     `requiredRuntimes` capability must be available on the platform.
 */

import {
  type PackManifest,
  type ProviderEngineCapability,
  satisfiesCoreRange,
} from "./manifest.js";

/** Where an effective-catalog entry came from. Core is the built-in catalog. */
export type EffectiveCatalogSource = "core" | "pack";

/**
 * Provenance carried by every effective-catalog entry. `core` entries record
 * only the source; `pack` entries additionally record the contributing pack's
 * identity (id / version / content digest) so a consumer can trace any problem
 * back to its immutable snapshot.
 */
export type EffectiveCatalogProvenance =
  | { readonly source: "core" }
  | {
      readonly source: "pack";
      readonly packId: string;
      readonly packVersion: string;
      readonly contentDigest: string;
    };

/**
 * One already-loaded core problem. `directory` is the catalog directory (the
 * `problems/<category>/<id>` value of {@link discoverProblemsCatalog}), and
 * `projections` carries every existing catalog projection (scoring, runtime,
 * endpoints, phases, visibility, disruptions, coordination, …) untouched so the
 * composer never needs to know their shapes.
 */
export interface CoreProblemInput {
  readonly problemId: string;
  readonly directory: string;
  readonly projections: Readonly<Record<string, unknown>>;
}

/** One already-loaded problem contributed by a pack snapshot. */
export interface PackProblemInput {
  readonly problemId: string;
  /** Pack-relative directory of the problem (e.g. `problems/challenges/x`). */
  readonly directory: string;
  readonly projections: Readonly<Record<string, unknown>>;
}

/**
 * One installed pack snapshot, already validated (#2088) and installed (#2090).
 * The `manifest` supplies the `core` range and `requiredRuntimes` that must be
 * satisfied before its `problems` are merged; `contentDigest` is the immutable
 * snapshot digest recorded in the lock.
 */
export interface PackSnapshotInput {
  readonly manifest: PackManifest;
  readonly contentDigest: string;
  readonly problems: readonly PackProblemInput[];
}

/** The platform context the pack manifests are validated against. */
export interface PlatformContext {
  /** Exact SemVer of the running platform core (e.g. `1.4.0`). */
  readonly coreVersion: string;
  /** Provider/engine capabilities the platform can satisfy. */
  readonly availableRuntimes: readonly ProviderEngineCapability[];
}

/** The complete input to {@link composeEffectiveCatalog}. */
export interface ComposeEffectiveCatalogInput {
  readonly core: readonly CoreProblemInput[];
  readonly packs: readonly PackSnapshotInput[];
  readonly platform: PlatformContext;
}

/** One merged entry in the effective catalog, with retained provenance. */
export interface EffectiveCatalogEntry {
  readonly problemId: string;
  readonly directory: string;
  readonly projections: Readonly<Record<string, unknown>>;
  readonly provenance: EffectiveCatalogProvenance;
}

/** Stable failure reasons so callers / CLIs can switch on the outcome. */
export type ComposeFailureReason =
  | "DUPLICATE_PROBLEM_ID"
  | "CORE_RANGE_UNSATISFIED"
  | "RUNTIME_UNAVAILABLE";

/** Discriminated result of {@link composeEffectiveCatalog}. Never throws. */
export type ComposeEffectiveCatalogResult =
  | { readonly ok: true; readonly entries: readonly EffectiveCatalogEntry[] }
  | { readonly ok: false; readonly reason: ComposeFailureReason; readonly message: string };

/** Reverse-DNS pack id plus the stamped version — the identity in a conflict. */
function packIdentity(manifest: PackManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

/** `provider/engine` key used to compare declared vs available capabilities. */
function capabilityKey(capability: ProviderEngineCapability): string {
  return `${capability.provider}/${capability.engine}`;
}

/**
 * Validate one pack manifest against the platform context BEFORE its problems
 * are eligible for merge: the core range must be satisfied and every required
 * runtime capability must be available. Returns a failure result, or undefined
 * when the pack is admissible.
 */
function validatePackAgainstPlatform(
  manifest: PackManifest,
  platform: PlatformContext,
): Extract<ComposeEffectiveCatalogResult, { ok: false }> | undefined {
  if (!satisfiesCoreRange(platform.coreVersion, manifest.core)) {
    return {
      ok: false,
      reason: "CORE_RANGE_UNSATISFIED",
      message: `Pack '${packIdentity(manifest)}' requires core '${manifest.core}', but the platform core is '${platform.coreVersion}'.`,
    };
  }
  const available = new Set(platform.availableRuntimes.map(capabilityKey));
  for (const required of manifest.requiredRuntimes) {
    if (!available.has(capabilityKey(required))) {
      return {
        ok: false,
        reason: "RUNTIME_UNAVAILABLE",
        message: `Pack '${packIdentity(manifest)}' requires runtime '${capabilityKey(required)}', which is not available on the platform.`,
      };
    }
  }
  return undefined;
}

/**
 * Sort packs into a stable composition order: by packId, then version, then by
 * each pack's problems by problemId. Pure — operates on copies, never mutating
 * the caller's arrays.
 */
function orderedPacks(packs: readonly PackSnapshotInput[]): readonly PackSnapshotInput[] {
  return [...packs]
    .sort(
      (a, b) =>
        a.manifest.id.localeCompare(b.manifest.id) ||
        a.manifest.version.localeCompare(b.manifest.version),
    )
    .map((pack) => ({
      ...pack,
      problems: [...pack.problems].sort((a, b) => a.problemId.localeCompare(b.problemId)),
    }));
}

/** A human-readable label for the source that first claimed a problem id. */
function originLabel(provenance: EffectiveCatalogProvenance): string {
  return provenance.source === "core"
    ? "core"
    : `pack '${provenance.packId}@${provenance.packVersion}'`;
}

/**
 * Compose the effective catalog from already-loaded core problems and validated
 * installed pack snapshots. Pure and deterministic. Returns `{ ok: false }` —
 * never throws — on any fail-closed condition (duplicate id, unsatisfied core
 * range, unavailable runtime).
 */
export function composeEffectiveCatalog(
  input: ComposeEffectiveCatalogInput,
): ComposeEffectiveCatalogResult {
  const entries: EffectiveCatalogEntry[] = [];
  // Track the first owner of each id so a duplicate can name BOTH identities.
  const owners = new Map<string, EffectiveCatalogProvenance>();

  const claim = (
    problemId: string,
    provenance: EffectiveCatalogProvenance,
  ): Extract<ComposeEffectiveCatalogResult, { ok: false }> | undefined => {
    const existing = owners.get(problemId);
    if (existing) {
      return {
        ok: false,
        reason: "DUPLICATE_PROBLEM_ID",
        message: `Problem id '${problemId}' is declared by ${originLabel(existing)} and ${originLabel(provenance)}. Each id must be unique across all sources; packs cannot override core.`,
      };
    }
    owners.set(problemId, provenance);
    return undefined;
  };

  // Core first, preserving the given (discovery) order.
  for (const problem of input.core) {
    const provenance: EffectiveCatalogProvenance = { source: "core" };
    const conflict = claim(problem.problemId, provenance);
    if (conflict) return conflict;
    entries.push({
      problemId: problem.problemId,
      directory: problem.directory,
      projections: problem.projections,
      provenance,
    });
  }

  // Then packs, validated against the platform, in stable packId/version order.
  for (const pack of orderedPacks(input.packs)) {
    const rejection = validatePackAgainstPlatform(pack.manifest, input.platform);
    if (rejection) return rejection;
    for (const problem of pack.problems) {
      const provenance: EffectiveCatalogProvenance = {
        source: "pack",
        packId: pack.manifest.id,
        packVersion: pack.manifest.version,
        contentDigest: pack.contentDigest,
      };
      const conflict = claim(problem.problemId, provenance);
      if (conflict) return conflict;
      entries.push({
        problemId: problem.problemId,
        directory: problem.directory,
        projections: problem.projections,
        provenance,
      });
    }
  }

  return { ok: true, entries };
}
