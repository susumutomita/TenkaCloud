import type { Client, ResultSet } from "@libsql/client/http";
import { describe, expect, it, vi } from "vitest";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../../lib/problem-deploy/control-data/libsql-executor.js";

function result(rows: readonly Record<string, unknown>[] = [], rowsAffected = 0): ResultSet {
  return {
    columns: rows.length > 0 ? Object.keys(rows[0] ?? {}) : [],
    columnTypes: [],
    rows,
    rowsAffected,
    lastInsertRowid: undefined,
    toJSON: () => ({}),
  } as unknown as ResultSet;
}

describe("LibsqlExecutor", () => {
  it("should map run/get/all onto parameterized libSQL execute calls", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result([], 3))
      .mockResolvedValueOnce(result([{ id: "one" }]))
      .mockResolvedValueOnce(result([{ id: "one" }, { id: "two" }]));
    const client = { execute } as unknown as Client;
    const sql = new LibsqlExecutor(client);

    await expect(sql.run("DELETE FROM t WHERE id = ?", ["one"])).resolves.toEqual({
      changes: 3,
    });
    await expect(sql.get("SELECT * FROM t WHERE id = ?", ["one"])).resolves.toEqual({
      id: "one",
    });
    await expect(sql.all("SELECT * FROM t")).resolves.toEqual([{ id: "one" }, { id: "two" }]);
    expect(execute).toHaveBeenNthCalledWith(1, {
      sql: "DELETE FROM t WHERE id = ?",
      args: ["one"],
    });
  });

  it("should run batch statements as one non-interactive write transaction (#2437)", async () => {
    const batch = vi.fn().mockResolvedValue([result([], 1), result([], 2)]);
    const client = { batch } as unknown as Client;
    const sql = new LibsqlExecutor(client);

    await expect(
      sql.batch([
        { sql: "INSERT INTO t (id) VALUES (?)", params: ["one"] },
        { sql: "INSERT INTO t (id) VALUES (?)", params: ["two"] },
      ]),
    ).resolves.toEqual([{ changes: 1 }, { changes: 2 }]);

    expect(batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = batch.mock.calls[0] ?? [];
    expect(mode).toBe("write");
    expect(statements).toEqual([
      { sql: "INSERT INTO t (id) VALUES (?)", args: ["one"] },
      { sql: "INSERT INTO t (id) VALUES (?)", args: ["two"] },
    ]);
  });

  it("should propagate a batch failure (transaction rolled back by libSQL)", async () => {
    const batch = vi
      .fn()
      .mockRejectedValue(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id"));
    const sql = new LibsqlExecutor({ batch } as unknown as Client);

    await expect(
      sql.batch([{ sql: "INSERT INTO t (id) VALUES (?)", params: ["dup"] }]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("should bootstrap all schema statements in one non-interactive write batch", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const client = { batch } as unknown as Client;

    await initializeControlDataSchema(client);

    expect(batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = batch.mock.calls[0] ?? [];
    expect(mode).toBe("write");
    expect(statements).toHaveLength(35);
    expect(statements.map((entry: { sql: string }) => entry.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS events"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS teams"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS notifications"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS tenant_feature_flags"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS deployments"),
        expect.stringContaining("idx_deployments_login_key_hash"),
        expect.stringContaining("idx_deployments_parent_deployment"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS deployment_score_events"),
        // [Issue #3123] The coordination table is now keyed by
        // tenant x event x problem x run. The legacy table is still created and
        // copied from in the same batch, so the migration is idempotent on
        // every cold start — and deliberately NOT dropped, so a rolling
        // deployment's old execution environments keep working against it.
        expect.stringContaining("CREATE TABLE IF NOT EXISTS coordination_state ("),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS coordination_state_scoped"),
        expect.stringContaining("INSERT OR IGNORE INTO coordination_state_scoped"),
        expect.stringContaining("idx_teams_login_key_hash"),
        expect.stringContaining("json_remove(payload, '$.teamLoginKey')"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS control_data_migrations"),
        expect.stringContaining("INSERT OR IGNORE INTO control_data_migrations"),
        // [Issue #2442 / Phase C1] ProblemEndpoints aggregate schema.
        expect.stringContaining("CREATE TABLE IF NOT EXISTS problem_endpoints"),
        // [Issue #2442 / Phase C2] CompetitorAccounts + SamlConfig aggregate schemas.
        expect.stringContaining("CREATE TABLE IF NOT EXISTS competitor_accounts"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS saml_configs"),
        // [Issue #2442 / Phase C5] SamlIdps aggregate schema (Lite-only IdP registry).
        expect.stringContaining("CREATE TABLE IF NOT EXISTS saml_idps"),
        // [Issue #2442 / Phase C3] Disruptions aggregate schema (one table per row shape).
        expect.stringContaining("CREATE TABLE IF NOT EXISTS disruption_audit"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS disruption_fire_claims"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS disruption_recurring"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS disruption_exec_claims"),
        // [Issue #2442 / Phase C4] AdminAuditLog aggregate schema.
        expect.stringContaining("CREATE TABLE IF NOT EXISTS admin_audit_log"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS score_summary"),
        expect.stringContaining("idx_score_summary_leaderboard"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS leaderboard_snapshots"),
      ]),
    );
  });
});
