import { z } from "zod";
import { readTenantFeatureFlags } from "../shared/tenant-feature-flags.js";
import { type EventSharedResources, resolveEventRepositories } from "./shared.js";

/**
 * Issue #2231: per-tenant runtime feature-flag overrides.
 *
 * The admin handler mirrors `lock-scoring.ts` and reuses the existing per-tenant Events table
 * (no new table — `DynamoDbLowCapacity` keeps the whole platform
 * inside the Free Tier budget, so every new table is a cost decision, not a free one).
 *
 * Schema (single item per tenant):
 *   PK: TENANT#<tenantId>
 *   SK: FLAGS
 *   flags: Record<string, boolean>
 *   updatedAt / updatedBy
 *
 * Design decision (deliberately NOT duplicating the frontend's `FEATURE_REGISTRY`): the
 * backend does not hold its own copy of the flag-key allowlist. Two definitions of "which
 * keys are real" is exactly the drift class #2203 fixed for the participant contract — a
 * flag added to the frontend registry would silently fail backend validation until someone
 * remembered to update a second list. Instead, `FeatureFlagsPatchSchema` validates the wire
 * shape only (identifier-looking string keys, boolean values, a sane key-count ceiling); an
 * unrecognized key is stored but has no effect, because `resolveFeatureFlags` (web-kit)
 * already discards override keys absent from the registry and non-boolean values. That
 * makes the registry the single source of truth for "which flags exist" while the backend's
 * job is narrower: reject garbage, and give TenantAdmin an audited on/off switch.
 */

const FLAG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MAX_FLAG_KEYS = 50;

export const FeatureFlagsPatchSchema = z
  .record(z.string().regex(FLAG_KEY_RE), z.boolean())
  .refine((flags) => Object.keys(flags).length <= MAX_FLAG_KEYS, {
    message: `too many flag keys (max ${MAX_FLAG_KEYS})`,
  });

/**
 * Read the tenant's stored flag overrides. No row yet (never saved) → `{}` (all registry
 * defaults). Row shape + read path live in `shared/tenant-feature-flags.ts` (#2283) so the
 * participant / scoring Lambdas apply the exact same flag judgement as this admin surface.
 */
export async function getFeatureFlags(
  shared: EventSharedResources,
  tenantId: string,
): Promise<Record<string, boolean>> {
  const repositories = await resolveEventRepositories(shared);
  return readTenantFeatureFlags(repositories.featureFlags, tenantId);
}

/**
 * Full-replace the tenant's flag overrides (Settings page saves the whole toggle state, not
 * a partial patch — a stale client re-sending an old flag set would otherwise silently
 * resurrect a flag another admin just turned off).
 */
export async function putFeatureFlags(
  shared: EventSharedResources,
  tenantId: string,
  flags: Record<string, boolean>,
  updatedBy: string,
  nowMs: number,
): Promise<Record<string, boolean>> {
  const repositories = await resolveEventRepositories(shared);
  await repositories.featureFlags.put({
    tenantId,
    flags,
    updatedAt: new Date(nowMs).toISOString(),
    updatedBy,
  });
  return flags;
}
