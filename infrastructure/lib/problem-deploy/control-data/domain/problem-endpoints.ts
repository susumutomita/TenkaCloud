/**
 * [Issue #2527 Slice 1] ProblemEndpoints aggregate — domain record and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

// ---------------------------------------------------------------------------
// [Issue #2442] ProblemEndpoints aggregate.
//
// Physical shape (unchanged, `dynamodb-problem-endpoint-keys.ts`):
//   PK = `TENANT#<tenantId>#TEAM#<teamId>#PROBLEM#<problemId>`
//   SK = `SLOT#<slot>`
// No GSI, no conditional writes, no Scan — the smallest of the control-data
// tables. `queryOverrides` is a single base-table Query (`begins_with(SK,
// "SLOT#")`); `putOverride` / `deleteOverride` are unconditional Put/Delete.
// ---------------------------------------------------------------------------

/**
 * [Issue #2442 / Phase C1] Domain shape of one (tenant, team, problem, slot)
 * override row, derived from the canonical DynamoDB row minus its physical
 * PK/SK. Those keys are an implementation detail of the DynamoDB backend; the
 * SQLite backend derives its own primary key columns (denormalized
 * `tenant_id` / `team_id` / `problem_id` / `slot`, the rest as a JSON
 * `payload`, per {@link SqlProblemEndpointsRepository}).
 */
export interface ProblemEndpointRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly slot: string;
  /** 競技者が portal で上書きした URL。未登録なら absent (= default URL 採用)。 */
  readonly overrideUrl?: string;
  /**
   * Phase 3.A では未使用 (= default URL は read-through 算出)。Phase 3.B 以降で deploy 完了
   * hook が書く余地を残す (`problem-endpoints-table.ts` の construct docblock を参照)。
   */
  readonly defaultCacheUrl?: string;
  readonly platform?: string;
  readonly updatedAt: string;
}

/**
 * [Issue #2442 / Phase C1] Aggregate-scoped repository for the ProblemEndpoints
 * aggregate — domain methods, not a generic key-value shim (mirror of
 * {@link TeamsRepository}). Two interchangeable backends:
 * {@link DynamoDbProblemEndpointsRepository} (status quo, default) and
 * {@link SqlProblemEndpointsRepository} (SQLite dialect for Turso / D1).
 * Selection happens at cold start via `CONTROL_DATA_BACKEND` through
 * {@link createProblemEndpointsRepository}.
 *
 * Unlike Events/Teams/Deployments, this aggregate has no conditional/atomic
 * writes and no Scan — every method is a plain point Put/Delete or a single
 * base-table Query scoped to a (tenant, team, problem) triple (at most a
 * handful of slots per problem, never paginated).
 */
export interface ProblemEndpointsRepository {
  /** Upsert one (tenant, team, problem, slot) override row. */
  putOverride(record: ProblemEndpointRecord): Promise<void>;
  /** Delete one override row by its domain identifiers (idempotent). */
  deleteOverride(tenantId: string, teamId: string, problemId: string, slot: string): Promise<void>;
  /**
   * Every override row for a (tenant, team, problem) triple. `slot` is not
   * globally ordered by either backend beyond an ascending sort — callers key
   * results by `slot` (via a `Map`), so ordering carries no domain meaning.
   */
  queryOverrides(
    tenantId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly ProblemEndpointRecord[]>;
}
