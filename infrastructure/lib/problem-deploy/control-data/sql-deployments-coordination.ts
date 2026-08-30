import type { CoordinationStateScope } from "./domain/coordination-scope.js";
import { normalizeJsonValue, type SqlDeploymentsCore } from "./sql-deployments-core.js";
import type {
  CoordinationStateRecord,
  DeploymentMutationOutcome,
  DeploymentsCoordinationPort,
} from "./types.js";

/**
 * [#2527 Slice 3] SQLite (Turso/libSQL) {@link DeploymentsCoordinationPort} adapter — optimistic-lock coordination plugin state,
 * moved verbatim from the pre-split `SqlDeploymentsRepository`. Engine
 * primitives (keys, conditional writes, pagination) live on
 * {@link SqlDeploymentsCore}.
 *
 * [Issue #3123] Rows live in `coordination_state_scoped`, keyed by
 * `(tenant_id, event_id, problem_id, run_id)`. See `sql-deployments-core.ts`
 * for the migration off the old two-column key and the compatibility policy.
 */
export class SqlDeploymentsCoordination implements DeploymentsCoordinationPort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async readCoordinationState(
    scope: CoordinationStateScope,
  ): Promise<CoordinationStateRecord | undefined> {
    const row = await this.core.sql.get(
      "SELECT state, version, expires_at FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
    if (!row) return undefined;
    // `expires_at` defaults to 0 in the schema, and 0 means "never expires"
    // (the sweep skips it) -- surfaced as undefined so the tick refreshes it on
    // sight, matching how a TTL-less DynamoDB row is treated.
    const expiresAt = Number(row.expires_at ?? 0);
    return {
      state: JSON.parse(String(row.state)),
      version: Number(row.version ?? 0),
      expiresAt: expiresAt > 0 ? expiresAt : undefined,
    };
  }

  /**
   * [Issue #3123] See `DeploymentsCoordinationPort.touchCoordinationState`.
   * An `UPDATE` matching no row is a no-op, which is the wanted behaviour for
   * an absent namespace.
   */
  async touchCoordinationState(scope: CoordinationStateScope, expiresAt: number): Promise<void> {
    await this.core.sql.run(
      "UPDATE coordination_state_scoped SET expires_at = ? WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [expiresAt, scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
  }

  /**
   * [Issue #3123] `expires_at` mirrors the DynamoDB row's TTL attribute so the
   * two backends converge on the same retention, even though SQLite has no
   * native TTL — {@link sweepExpiredCoordinationState} is what actually reaps
   * here. Refreshed on every write, so the clock only starts once a match stops
   * being played.
   */
  async writeCoordinationState(
    scope: CoordinationStateScope,
    state: unknown,
    expectedVersion: number,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    const result = await this.core.sql.run(
      `INSERT INTO coordination_state_scoped (tenant_id, event_id, problem_id, run_id, state, version, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, event_id, problem_id, run_id) DO UPDATE SET
         state = excluded.state,
         version = excluded.version,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at
       WHERE coordination_state_scoped.version = ?`,
      [
        scope.tenantId,
        scope.eventId,
        scope.problemId,
        scope.runId,
        JSON.stringify(normalizeJsonValue(state)),
        expectedVersion + 1,
        at,
        expiresAt,
        expectedVersion,
      ],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "conflict" };
  }

  /**
   * [Issue #3123] Deletes exactly this scope's row. Idempotent — a `DELETE`
   * matching nothing is a success, so a retried or half-finished teardown
   * converges rather than erroring.
   *
   * Unlike the DynamoDB adapter there is no separate pre-scope row to clear:
   * the schema migration already folded any legacy row into the reserved
   * `__pre_scope__` namespace, and that namespace has no live scope to be
   * deleted through.
   */
  async deleteCoordinationState(scope: CoordinationStateScope): Promise<void> {
    await this.core.sql.run(
      "DELETE FROM coordination_state_scoped WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [scope.tenantId, scope.eventId, scope.problemId, scope.runId],
    );
  }

  /**
   * [Issue #3123] The retention primitive for rows no teardown ever deleted.
   * `expires_at > 0` skips rows written without a TTL (the migrated
   * `__pre_scope__` rows), the same guard the disruptions repository's sweep
   * uses.
   *
   * Has no scheduled caller yet — see `DeploymentsCoordinationPort`'s docstring
   * for why that is a platform-wide gap rather than a coordination one, and for
   * what it means for Turso/DynamoDB parity in the meantime.
   */
  async sweepExpiredCoordinationState(nowEpochSeconds: number): Promise<number> {
    const result = await this.core.sql.run(
      "DELETE FROM coordination_state_scoped WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}
