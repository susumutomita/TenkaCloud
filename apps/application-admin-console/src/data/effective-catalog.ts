/**
 * [Problem Packs / Issue #2093] Console-side EFFECTIVE catalog projection.
 *
 * The organizer console used to derive its catalog purely from the local core
 * `problems/` tree (a Vite build-time glob). This module turns that into the
 * EFFECTIVE catalog: the local core problems PLUS the problems contributed by
 * already-installed pack snapshots.
 *
 * Contract parity with the backend composer (#2091
 * `infrastructure/lib/problem-pack/effective-catalog.ts`): the merge follows the
 * SAME fail-closed rules — core is claimed FIRST, a pack id that collides with
 * core (or another pack) fails closed naming BOTH owners, and packs can NEVER
 * override core. The backend composer additionally validates each pack's core
 * SemVer range and required-runtime capabilities; those are DEPLOY concerns and
 * are intentionally NOT replicated here — the console only DISPLAYS the catalog,
 * never deploys from it, so pulling the backend's Node-only validator chain into
 * the browser bundle would be wrong. The display-relevant subset (id claiming,
 * duplicate detection, stable order) is what this module mirrors.
 *
 * Compatibility discipline (the whole point of this seam):
 *   - A core-only checkout (no installed pack snapshots) yields EXACTLY the core
 *     catalog, with NO pack provenance fields on any entry, so the legacy
 *     core-only UI (cards / filters / sort / detail / cost) is byte-identical and
 *     keeps working with no backend pack activation.
 *   - Pack provenance (`source` / `packId` / `packVersion` / `license`) is OPTIONAL
 *     display metadata attached ONLY to problems that actually come from a pack.
 *     It is never an authorization input — the console only renders it.
 *   - No pack source file is fetched client-side: pack `metadata.json` /
 *     `tenkacloud-pack.json` are taken from the build-time inputs the caller
 *     globbed, exactly like the core path.
 *   - Cost estimation is NEVER attempted for non-AWS / non-CloudFormation
 *     artifacts (guarded via {@link isExecutableProblemRuntime}); a non-AWS
 *     template would otherwise be mis-parsed as CloudFormation.
 */

import {
  isExecutableProblemRuntime,
  isLocalOnlyProblemRuntime,
  metadataRuntimeToSummary,
  metadataToDetail,
} from "./problem-mapping";
import type { ProblemDetail, ProblemMetadata } from "./problem-types";

/**
 * One already-loaded core problem: its raw `metadata.json` plus the optional
 * `template.yaml` body (used for the offline cost estimate).
 */
export interface CoreCatalogInput {
  readonly metadata: ProblemMetadata;
  readonly templateYaml: string | undefined;
}

/**
 * One already-loaded pack problem. `metadata` / `templateYaml` come from the
 * installed snapshot's files (globbed at build time, never fetched at runtime);
 * the pack identity fields are read from the snapshot's `tenkacloud-pack.json`.
 */
export interface PackCatalogProblemInput extends CoreCatalogInput {
  readonly packId: string;
  readonly packVersion: string;
  readonly license: string;
}

/** The full input to {@link buildEffectiveCatalog}: core problems plus pack problems. */
export interface EffectiveCatalogInput {
  readonly core: readonly CoreCatalogInput[];
  readonly packs: readonly PackCatalogProblemInput[];
}

/**
 * The console only ever displays an AWS CloudFormation template's cost, so the
 * offline analyzer must run only for executable AWS/CloudFormation runtimes. For
 * every other runtime the template body is dropped before {@link metadataToDetail}
 * sees it, guaranteeing the cost analyzer is never invoked on a non-AWS artifact.
 */
const runtimeOf = metadataRuntimeToSummary;

function templateForCost(
  metadata: ProblemMetadata,
  templateYaml: string | undefined,
): string | undefined {
  return isExecutableProblemRuntime(runtimeOf(metadata)) ? templateYaml : undefined;
}

/**
 * [#2168] The organizer console is the CLOUD console: its catalog is the set of
 * problems an operator can build a cloud event from. A local-only `docker/compose` problem,
 * delivered through Docker local-play, is categorically not that — the deploy worker rejects a
 * cloud deploy of it before any mutation — so listing it here only invites the operator
 * to pick a problem they cannot deploy. We drop those entries from the effective catalog
 * (browse + event picker alike); they remain reachable through the local-play path
 * (`make local`), which is where a container runtime is actually run. Reserved
 * (planned-provider) problems are NOT dropped: they stay visible so the picker can show
 * them as coming-soon / selectable-when-enabled.
 */
function isCloudCatalogEntry(metadata: ProblemMetadata): boolean {
  return !isLocalOnlyProblemRuntime(runtimeOf(metadata));
}

/** A core entry carries no pack provenance — the legacy projection, unchanged. */
function coreDetail(input: CoreCatalogInput): ProblemDetail {
  return metadataToDetail(input.metadata, templateForCost(input.metadata, input.templateYaml));
}

/** A pack entry is the legacy projection PLUS the optional provenance fields. */
function packDetail(input: PackCatalogProblemInput): ProblemDetail {
  return {
    ...metadataToDetail(input.metadata, templateForCost(input.metadata, input.templateYaml)),
    source: "pack",
    packId: input.packId,
    packVersion: input.packVersion,
    license: input.license,
  };
}

/** A human-readable label for the source that first claimed a problem id. */
function originLabel(detail: ProblemDetail): string {
  return detail.source === "pack" ? `pack '${detail.packId}@${detail.packVersion}'` : "core";
}

/**
 * Compose the EFFECTIVE catalog from core problems and installed pack problems.
 *
 * Mirrors the backend composer's fail-closed merge: core is claimed first, then
 * packs; a duplicate id (core/pack or pack/pack) THROWS naming BOTH owners rather
 * than silently dropping or overriding an entry — a mis-installed pack must be
 * visible, not masked. With an empty `packs` array the result is byte-identical to
 * the legacy core-only catalog. Returns details sorted by id for a stable display
 * order (matching the previous `PROBLEM_CATALOG` ordering).
 */
export function buildEffectiveCatalog(input: EffectiveCatalogInput): readonly ProblemDetail[] {
  const owners = new Map<string, ProblemDetail>();

  const claim = (detail: ProblemDetail): void => {
    const existing = owners.get(detail.id);
    if (existing) {
      throw new Error(
        `[effective-catalog] DUPLICATE_PROBLEM_ID: Problem id '${detail.id}' is declared by ` +
          `${originLabel(existing)} and ${originLabel(detail)}. Each id must be unique across all ` +
          "sources; packs cannot override core.",
      );
    }
    owners.set(detail.id, detail);
  };

  // Core first, preserving the given (discovery) order — packs cannot override it.
  // Local-only (#2168) problems are excluded from this cloud console catalog.
  for (const entry of input.core) {
    if (isCloudCatalogEntry(entry.metadata)) claim(coreDetail(entry));
  }
  for (const entry of input.packs) {
    if (isCloudCatalogEntry(entry.metadata)) claim(packDetail(entry));
  }

  return [...owners.values()].sort((a, b) => a.id.localeCompare(b.id));
}
