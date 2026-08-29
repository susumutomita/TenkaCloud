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
 */
export class SqlDeploymentsCoordination implements DeploymentsCoordinationPort {
  constructor(private readonly core: SqlDeploymentsCore) {}

  async readCoordinationState(
    tenantId: string,
    eventId: string,
    problemId = "legacy",
    runId = "legacy",
  ): Promise<CoordinationStateRecord | undefined> {
    const row = await this.core.sql.get(
      "SELECT state, version FROM coordination_state_v2 WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [tenantId, eventId, problemId, runId],
    );
    if (!row) return undefined;
    return { state: JSON.parse(String(row.state)), version: Number(row.version ?? 0) };
  }

  async writeCoordinationState(
    tenantId: string,
    eventId: string,
    state: unknown,
    expectedVersion: number,
    at: string,
    problemId = "legacy",
    runId = "legacy",
  ): Promise<DeploymentMutationOutcome> {
    const result = await this.core.sql.run(
      `INSERT INTO coordination_state_v2 (tenant_id, event_id, problem_id, run_id, state, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, event_id, problem_id, run_id) DO UPDATE SET
         state = excluded.state,
         version = excluded.version,
         updated_at = excluded.updated_at
       WHERE coordination_state_v2.version = ?`,
      [
        tenantId,
        eventId,
        problemId,
        runId,
        JSON.stringify(normalizeJsonValue(state)),
        expectedVersion + 1,
        at,
        expectedVersion,
      ],
    );
    return Number(result.changes) > 0 ? { outcome: "updated" } : { outcome: "conflict" };
  }

  async deleteCoordinationState(
    tenantId: string,
    eventId: string,
    problemId: string,
    runId: string,
  ): Promise<void> {
    await this.core.sql.run(
      "DELETE FROM coordination_state_v2 WHERE tenant_id = ? AND event_id = ? AND problem_id = ? AND run_id = ?",
      [tenantId, eventId, problemId, runId],
    );
  }
}
