import type { EffectiveCatalogProvenance } from "../../../problem-pack/effective-catalog.js";
import type { DeploymentProvenance } from "../../control-data/domain/deployments.js";

/**
 * [Problem Packs / Issue #2096] Deployment + audit pack provenance projection.
 *
 * For PACK-SOURCED deployments we persist and display the resolved source
 * identity — pack id / version / content digest plus the event's
 * `catalogSnapshotId`. The provenance is copied from the EVENT-pinned catalog
 * snapshot (#2095), NEVER from client input: the deploy path passes only a
 * server-resolved `EffectiveCatalogProvenance`, and this module projects it onto
 * the display/audit-safe shape.
 *
 * Core (non-pack) deployments keep the EXISTING row shape and response unchanged:
 * {@link toDeploymentProvenance} returns `undefined` for `source: "core"`, so no
 * `provenance` attribute is ever written or returned for them.
 *
 * [Issue #2527 Slice 1 step 2] The {@link DeploymentProvenance} shape itself
 * (with its closed-surface security rationale) lives on the domain module
 * (`control-data/domain/deployments.ts`); this handler keeps the projection
 * functions and re-exports the type for its existing importers.
 */
export type { DeploymentProvenance } from "../../control-data/domain/deployments.js";

/**
 * Project an event-pinned snapshot provenance onto the display/audit-safe
 * {@link DeploymentProvenance}. Returns `undefined` for a core problem or when no
 * snapshot provenance was resolved, so a core deployment row and response stay
 * byte-identical to the pre-#2096 shape.
 */
export function toDeploymentProvenance(
  resolved: EffectiveCatalogProvenance | undefined,
  catalogSnapshotId: string,
): DeploymentProvenance | undefined {
  if (resolved?.source !== "pack") return undefined;
  return {
    packId: resolved.packId,
    packVersion: resolved.packVersion,
    contentDigest: resolved.contentDigest,
    catalogSnapshotId,
  };
}

/**
 * The DDB item attribute(s) to spread onto a `DeploymentItem`. A pack deployment
 * gets `{ provenance }`; a core deployment gets `{}` (no attribute), keeping the
 * legacy row byte-identical.
 */
export function provenanceItemFields(provenance: DeploymentProvenance | undefined): {
  provenance?: DeploymentProvenance;
} {
  return provenance ? { provenance } : {};
}

/**
 * The audit `extra` map for a deployment. Every provenance field is a string, so
 * a pack deployment contributes all four; a core deployment contributes none.
 */
export function provenanceAuditExtra(
  provenance: DeploymentProvenance | undefined,
): Readonly<Record<string, string>> {
  if (!provenance) return {};
  return {
    packId: provenance.packId,
    packVersion: provenance.packVersion,
    contentDigest: provenance.contentDigest,
    catalogSnapshotId: provenance.catalogSnapshotId,
  };
}
