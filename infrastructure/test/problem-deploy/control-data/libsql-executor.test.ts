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

  it("should bootstrap all schema statements in one non-interactive write batch", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const client = { batch } as unknown as Client;

    await initializeControlDataSchema(client);

    expect(batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = batch.mock.calls[0] ?? [];
    expect(mode).toBe("write");
    expect(statements).toHaveLength(11);
    expect(statements.map((entry: { sql: string }) => entry.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS events"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS teams"),
        expect.stringContaining("idx_teams_login_key_hash"),
        expect.stringContaining("json_remove(payload, '$.teamLoginKey')"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS control_data_migrations"),
        expect.stringContaining("INSERT OR IGNORE INTO control_data_migrations"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS score_summary"),
        expect.stringContaining("idx_score_summary_leaderboard"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS leaderboard_snapshots"),
      ]),
    );
  });
});
