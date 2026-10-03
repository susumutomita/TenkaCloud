/**
 * [Issue #2527 Slice 1] Tenant SAML config sub-aggregate — domain record and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/**
 * [Issue #2442 / Phase C2] Domain shape of the per-tenant SAML SSO config row
 * (Issue #839 follow-up Phase B). Physically a sparse `SK = "SAML_CONFIG"` row
 * in the CompetitorAccounts table's `TENANT#<tenantId>` partition — **not**
 * the separate `SamlIdps` table (#1312, Lite-only IdP registry; do not
 * confuse the two). `tenantId` is part of the domain record here (unlike the
 * pre-seam `saml-store.ts` DDB row, which derives it from PK only) because the
 * SQL backend needs it as an explicit primary-key column.
 */
export interface SamlConfigRecord {
  readonly tenantId: string;
  readonly metadataUrl: string;
  readonly providerName: string;
  readonly attributeMapping: Readonly<Record<string, string>>;
  readonly enforceSamlOnly: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * [Issue #2442 / Phase C2] Repository for the tenant SAML config sub-aggregate
 * — 3 plain point operations, no conditional writes (mirrors
 * {@link FeatureFlagsRepository}'s upsert-only shape). Two interchangeable
 * backends: {@link DynamoDbSamlConfigRepository} (default) and
 * {@link SqlSamlConfigRepository} (own SQL table, `saml_configs`, despite
 * sharing the CompetitorAccounts DynamoDB table — same precedent as
 * Notifications/FeatureFlags getting their own SQL table while co-habiting
 * the Events DynamoDB table, #2439).
 */
export interface SamlConfigRepository {
  /** Current config for a tenant, or `undefined` when never configured. */
  getSamlConfig(tenantId: string): Promise<SamlConfigRecord | undefined>;
  /** Upsert (full replace) — returns the row as written. */
  putSamlConfig(record: SamlConfigRecord): Promise<SamlConfigRecord>;
  /** Delete the config row (idempotent — a no-op when already absent). */
  deleteSamlConfig(tenantId: string): Promise<void>;
}
