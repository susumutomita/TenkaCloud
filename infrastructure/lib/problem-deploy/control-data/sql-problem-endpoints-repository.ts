import type { ProblemEndpointRecord, ProblemEndpointsRepository, SqlExecutor } from "./types.js";

/**
 * [Issue #2442 / Phase C1] SQLite schema for the ProblemEndpoints aggregate. One
 * SQL layer in the SQLite dialect targets the Turso (libSQL) hosted backend
 * (#2677: Turso-only).
 *
 * The composite primary key mirrors the DynamoDB physical PK/SK exactly
 * (`tenant_id`/`team_id`/`problem_id`/`slot` decompose
 * `TENANT#<t>#TEAM#<tid>#PROBLEM#<pid>` / `SLOT#<slot>`), so the same
 * (tenant, team, problem) triple used for the base-table Query on DynamoDB
 * drives an indexed lookup here too. The full record is additionally stored as
 * a JSON `payload` so new override attributes (e.g. a future `platform` /
 * `defaultCacheUrl` write path) round-trip without a migration — the same
 * "denormalized columns for the query path, payload for everything else"
 * split {@link SqlTeamsRepository} uses.
 */
export const PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS problem_endpoints (
  tenant_id  TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  slot       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, team_id, problem_id, slot)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const PROBLEM_ENDPOINTS_SCHEMA_SQL = `${PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS.join(";\n")};`;

function rowToRecord(payload: unknown): ProblemEndpointRecord {
  return JSON.parse(String(payload)) as ProblemEndpointRecord;
}

/**
 * [Issue #2442 / Phase C1] SQLite implementation of {@link ProblemEndpointsRepository}.
 * No conditional writes, no Scan — every method maps to exactly one statement.
 */
export class SqlProblemEndpointsRepository implements ProblemEndpointsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async putOverride(record: ProblemEndpointRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO problem_endpoints (tenant_id, team_id, problem_id, slot, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, team_id, problem_id, slot) DO UPDATE SET payload = excluded.payload`,
      [record.tenantId, record.teamId, record.problemId, record.slot, JSON.stringify(record)],
    );
  }

  async deleteOverride(
    tenantId: string,
    teamId: string,
    problemId: string,
    slot: string,
  ): Promise<void> {
    await this.sql.run(
      "DELETE FROM problem_endpoints WHERE tenant_id = ? AND team_id = ? AND problem_id = ? AND slot = ?",
      [tenantId, teamId, problemId, slot],
    );
  }

  async queryOverrides(
    tenantId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly ProblemEndpointRecord[]> {
    const rows = await this.sql.all(
      // slot 昇順で決定的な順序にする (DDB base-table SK 昇順の鏡像。ドメイン上の意味は無いが
      // backend 間で安定した順序にしておくと byte-pin テストが書きやすい)。
      "SELECT payload FROM problem_endpoints WHERE tenant_id = ? AND team_id = ? AND problem_id = ? ORDER BY slot ASC",
      [tenantId, teamId, problemId],
    );
    return rows.map((row) => rowToRecord(row.payload));
  }
}
