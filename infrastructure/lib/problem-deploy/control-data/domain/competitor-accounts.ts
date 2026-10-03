/**
 * [Issue #2527 Slice 1] CompetitorAccounts aggregate — domain records, mutation outcomes, and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

// ---------------------------------------------------------------------------
// [Issue #2442] CompetitorAccounts aggregate (Issue #459).
//
// Physical shape (unchanged, `competitor-accounts-table.ts`):
//   PK = `TENANT#<tenantId>` / SK = `ACCOUNT#<awsAccountId>`
// No GSI. A sparse `SK = "SAML_CONFIG"` row co-habits the same partition
// (Issue #839 follow-up Phase B) — a **distinct** sub-aggregate (never confuse
// with the separate `SamlIdps` table, #1312), modeled below as its own
// {@link SamlConfigRepository} in the same style Notifications/FeatureFlags
// share the Events table's partition (#2439) while getting their own SQL
// table. Two conditional writes exist here: duplicate prevention on create
// (`attribute_not_exists`) and a verify-gate update (`attribute_exists`) —
// both use the {@link CompetitorAccountMutationOutcome} / {@link
// CreateCompetitorAccountOutcome} union contract established by A2/B2.
// ---------------------------------------------------------------------------

/**
 * [Issue #2442 / Phase C2] Domain shape of one (tenant, awsAccountId)
 * competitor account row. The SQLite backend derives its own primary key columns
 * (denormalized `tenant_id` / `aws_account_id`, the rest as a JSON `payload`,
 * per {@link SqlCompetitorAccountsRepository}).
 * [Issue #2527 Slice 1 step 2] Source of truth; the physical row
 * (`handlers/competitor-accounts-handler/types.ts`'s `CompetitorAccountItem`)
 * adds PK/SK.
 */
export type CompetitorAccountRecord = {
  tenantId: string;
  awsAccountId: string;
  region: string;
  competitorRoleName: string;
  alias?: string;
  verified: boolean;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 最後に ExternalId を rotate した時刻 (Issue #596)。
   * 過去 row には存在しない (= undefined のときは「未 rotate = createdAt から経過」とみなす)。
   */
  rotatedAt?: string;
  /** Cognito sub (= operator 監査用)。`unknown` の場合は JWT 解決失敗 (test / dev fallback)。 */
  createdBy: string;
};

/**
 * [Issue #2442 / Phase C2] Result of {@link CompetitorAccountsRepository.createAccount}.
 * Mirrors {@link CreateEventWithTeamsOutcome}: DynamoDB signals a uniqueness
 * violation via `attribute_not_exists(PK) AND attribute_not_exists(SK)` failing
 * (`ConditionalCheckFailedException`); the SQL backend via a PRIMARY KEY
 * constraint violation. Nothing is written on `conflict` on either backend.
 */
export type CreateCompetitorAccountOutcome =
  | { readonly outcome: "created" }
  | { readonly outcome: "conflict" };

/**
 * [Issue #2442 / Phase C2] Result of one conditional CompetitorAccount
 * mutation (`markVerified` / `deleteAccount`). Both methods condition only on
 * row presence (`attribute_exists(PK) AND attribute_exists(SK)` on DynamoDB, a
 * `changes > 0` check on SQL) — a failed condition always means the row is
 * absent, so this union never carries a `conflict` arm (unlike {@link
 * EventMutationOutcome}, which has methods with a state-based condition).
 * `markVerified` runs with the DynamoDB twin's `ReturnValues: ALL_NEW` (SQL:
 * `UPDATE … RETURNING payload`), so it carries the post-image; `deleteAccount`
 * mirrors the pre-seam handler's fire-and-forget delete and carries none.
 */
export type CompetitorAccountMutationOutcome =
  | { readonly outcome: "updated"; readonly record?: CompetitorAccountRecord }
  | { readonly outcome: "not_found" };

/**
 * [Issue #2442 / Phase C2] Aggregate-scoped repository for the
 * CompetitorAccounts aggregate — domain methods, not a generic key-value shim
 * (mirror of {@link TeamsRepository}). Two interchangeable backends:
 * {@link DynamoDbCompetitorAccountsRepository} (status quo, default) and
 * {@link SqlCompetitorAccountsRepository} (SQLite dialect for Turso / D1).
 * Selection happens at cold start via `CONTROL_DATA_BACKEND` through
 * {@link createCompetitorAccountsRepository}.
 *
 * Every method here is a verbatim relocation of the pre-seam
 * `competitor-accounts-handler/store.ts` access pattern — no speculative API.
 */
export interface CompetitorAccountsRepository {
  /**
   * Registers a new `(tenantId, awsAccountId)` row. `conflict` = the pair is
   * already registered for this tenant (duplicate-prevention gate); nothing
   * is written. The caller supplies the full record (including
   * `verified: false` and audit fields) — SSM ExternalId provisioning stays
   * outside the seam (a distinct SSM SecureString concern).
   */
  createAccount(record: CompetitorAccountRecord): Promise<CreateCompetitorAccountOutcome>;
  /** Every competitor account row for a tenant (verified and unverified alike). */
  listAccounts(tenantId: string): Promise<readonly CompetitorAccountRecord[]>;
  /** Tenant-scoped point read. `undefined` when the row is absent. */
  getAccount(tenantId: string, awsAccountId: string): Promise<CompetitorAccountRecord | undefined>;
  /**
   * Sets `verified = true` + `verifiedAt` (called only after a successful STS
   * AssumeRole sanity check). `not_found` when the row does not exist.
   */
  markVerified(
    tenantId: string,
    awsAccountId: string,
    verifiedAt: string,
  ): Promise<CompetitorAccountMutationOutcome>;
  /**
   * Deletes one row. `not_found` when the row does not exist (so the caller
   * can 404 without a separate existence probe — the pre-seam handler used
   * the DynamoDB `ConditionExpression` for the same atomic TOCTOU-free check).
   */
  deleteAccount(tenantId: string, awsAccountId: string): Promise<CompetitorAccountMutationOutcome>;
  /**
   * Whether at least one competitor account row remains for a tenant (the
   * pre-seam handler's `Select: COUNT, Limit: 1` post-delete check, used to
   * decide whether the tenant's SSM ExternalId should also be cleaned up).
   */
  hasRemainingAccounts(tenantId: string): Promise<boolean>;
  /**
   * [Issue #2442 / Phase C2] Streams every CompetitorAccounts row's
   * rotation-audit projection (`tenantId` / `awsAccountId` / `rotatedAt` /
   * `createdAt`), one physical page at a time — the B3 per-page callback
   * pattern (mirrors `DeploymentsRepository.forEachCompleteDeploymentPage`).
   * Site: `external-id-audit-handler` (daily ExternalId rotation-age audit).
   * The DynamoDB backend issues the pre-seam's verbatim
   * `ProjectionExpression` Scan; the SQL backend has no native pagination at
   * this scale and calls `onPage` once with every row (mirrors every other
   * SQL `forEach*Page` implementation in this file).
   * [Issue #2527 Slice 1 step 2] The page items are typed as the domain record
   * projection (the physical-key attributes a backend Scan may carry are an
   * adapter detail and no longer leak through this port).
   */
  forEachCompetitorAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountRecord>[]) => Promise<void>,
  ): Promise<void>;
}
