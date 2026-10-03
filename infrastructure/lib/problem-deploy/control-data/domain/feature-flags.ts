/**
 * [Issue #2527 Slice 1] TenantFeatureFlags aggregate — domain record and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/**
 * [#2439] TenantFeatureFlags の domain shape(tenantId / flags / updatedAt / updatedBy)。
 * [Issue #2527 Slice 1 step 2] Source of truth; the physical FLAGS row
 * (`handlers/shared/tenant-feature-flags.ts`) adds PK/SK on top of these fields.
 */
export type TenantFeatureFlagsRecord = {
  readonly tenantId: string;
  readonly flags: Record<string, boolean>;
  readonly updatedAt: string;
  readonly updatedBy: string;
};

/**
 * TenantFeatureFlags has no TTL / expiresAt attribute, so it intentionally does
 * not expose `pruneExpired`; manual prune covers only Events / Teams /
 * Notifications.
 */
export interface FeatureFlagsRepository {
  /** 行が無い(未保存)→ undefined。 caller 側 helper が `{}` に畳む(現行挙動)。 */
  get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined>;
  /**
   * 全置換 upsert(admin Settings 保存)。 audit fields (updatedAt/updatedBy) を含む
   * record 全体を渡す — issue 本文の `put(tenantId, flags)` から意図的に refine
   * (putEvent(record) の先行 precedent と同型、 audit fields を落とさないため)。
   */
  put(record: TenantFeatureFlagsRecord): Promise<void>;
}
