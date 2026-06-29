import type { EffectiveCatalogProvenance } from "../../../problem-pack/effective-catalog.js";

/**
 * [Problem Packs / Issue #2096] Deployment + audit pack provenance.
 *
 * For PACK-SOURCED deployments we persist and display the resolved source
 * identity — pack id / version / content digest plus the event's
 * `catalogSnapshotId`. The provenance is copied from the EVENT-pinned catalog
 * snapshot (#2095), NEVER from client input: the deploy path passes only a
 * server-resolved `EffectiveCatalogProvenance`, and this module projects it onto
 * the display/audit-safe shape below.
 *
 * Core (non-pack) deployments keep the EXISTING row shape and response unchanged:
 * {@link toDeploymentProvenance} returns `undefined` for `source: "core"`, so no
 * `provenance` attribute is ever written or returned for them.
 *
 * Security: the shape is closed to id / version / digest / snapshot id only. A
 * pack's mutable source (`sourceRef`, `snapshotPath`, local directory, git
 * credentials) lives in the lock / snapshot store and never reaches this shape,
 * so it can never appear in an API response, the DDB row, or an audit record.
 */
export interface DeploymentProvenance {
  /** Reverse-DNS pack id from the immutable pinned snapshot. */
  readonly packId: string;
  /** Exact SemVer of the pack from the immutable pinned snapshot. */
  readonly packVersion: string;
  /** Hex content digest of the pinned pack snapshot. */
  readonly contentDigest: string;
  /** Deterministic id of the event's pinned catalog snapshot. */
  readonly catalogSnapshotId: string;
}

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
  if (!resolved || resolved.source !== "pack") return undefined;
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
