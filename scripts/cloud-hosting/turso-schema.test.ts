import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resetKnownTursoData, type TursoResetSql } from "./turso-reset";
import { assertTursoSchemaCompatible, PUBLISHED_CLOUD_DATA_TABLES } from "./turso-schema";

function fixture(statements: readonly string[]) {
  const db = new Database(":memory:");
  for (const sql of statements) db.run(sql);
  const calls: string[] = [];
  const client: TursoResetSql = {
    execute: async (sql) => {
      calls.push(sql);
      return { rows: db.query(sql).all() as Record<string, unknown>[] };
    },
    batch: async (statements, mode) => {
      expect(mode).toBe("write");
      db.transaction(() => {
        for (const entry of statements) {
          calls.push(entry.sql);
          db.run(entry.sql);
        }
      })();
    },
  };
  return { db, client, calls };
}
describe("read-only Turso schema compatibility", () => {
  it.each(["cloud_schema", "cloud_events", "cloud_teams", "cloud_deployments"])(
    "rejects %s before any mutation even without an AWS stack",
    async (name) => {
      const f = fixture([
        `CREATE TABLE ${name} (id TEXT)`,
        `INSERT INTO ${name} VALUES ('preserved')`,
      ]);
      try {
        await expect(assertTursoSchemaCompatible(f.client)).rejects.toThrow();
        expect(f.calls.every((sql) => sql.startsWith("SELECT "))).toBe(true);
        expect(f.db.query(`SELECT id FROM ${name}`).get()).toEqual({ id: "preserved" });
      } finally {
        f.db.close();
      }
    },
  );
  it.each([{ tables: [] }, { tables: ["events", "teams", "deployments"] }])(
    "accepts empty and old Lite table names without creating schema: %j",
    async ({ tables }) => {
      const f = fixture(tables.map((name) => `CREATE TABLE ${name} (id TEXT)`));
      try {
        await assertTursoSchemaCompatible(f.client);
        expect(f.calls).toHaveLength(2);
        expect(
          f.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
        ).toHaveLength(tables.length);
      } finally {
        f.db.close();
      }
    },
  );
  it("allows a known empty published schema after explicit data purge without dropping tables", async () => {
    const f = fixture([
      "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY, version INTEGER)",
      "INSERT INTO cloud_schema VALUES (1, 1)",
      "CREATE TABLE cloud_events (event_id TEXT)",
      "CREATE TABLE cloud_teams (team_id TEXT)",
    ]);
    try {
      await assertTursoSchemaCompatible(f.client);
      expect(f.calls.every((sql) => sql.startsWith("SELECT "))).toBe(true);
      expect(
        f.db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get(),
      ).toEqual({ count: 3 });
      f.db.run("INSERT INTO cloud_teams VALUES ('existing-team')");
      await expect(assertTursoSchemaCompatible(f.client)).rejects.toThrow("cloud-v1");
      expect(f.db.query("SELECT team_id FROM cloud_teams").get()).toEqual({
        team_id: "existing-team",
      });
    } finally {
      f.db.close();
    }
  });
  it("does not adopt unknown table names or a different published schema version", async () => {
    for (const extra of [
      "CREATE TABLE cloud_unrelated (id TEXT)",
      "UPDATE cloud_schema SET version=2",
    ]) {
      const f = fixture([
        "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY, version INTEGER)",
        "INSERT INTO cloud_schema VALUES (1, 1)",
        extra,
      ]);
      try {
        await expect(assertTursoSchemaCompatible(f.client)).rejects.toThrow("cloud-v1");
      } finally {
        f.db.close();
      }
    }
  });
});
describe("explicit Turso purge preserves schema and unrelated data", () => {
  it("accepts the previously published schema after its explicit purge, including the transaction guard", async () => {
    const f = fixture([
      "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
      "INSERT INTO cloud_schema VALUES (1, 1)",
      "CREATE TABLE cloud_transaction_guard (id INTEGER PRIMARY KEY, valid INTEGER CHECK(valid=1))",
      "INSERT INTO cloud_transaction_guard VALUES (1, 1)",
      ...PUBLISHED_CLOUD_DATA_TABLES.filter((name) => name !== "cloud_transaction_guard").flatMap(
        (name) => [
          `CREATE TABLE ${name} (id TEXT)`,
          `INSERT INTO ${name} VALUES ('synthetic-existing-row')`,
        ],
      ),
      "CREATE TABLE unrelated (id TEXT)",
      "INSERT INTO unrelated VALUES ('preserved')",
    ]);
    try {
      await expect(assertTursoSchemaCompatible(f.client)).rejects.toThrow("cloud-v1");
      expect(f.calls.every((sql) => sql.startsWith("SELECT "))).toBe(true);
      await resetKnownTursoData(f.client, "cloud-v1");
      const readOnlyStart = f.calls.length;
      await assertTursoSchemaCompatible(f.client);
      expect(f.calls.slice(readOnlyStart).every((sql) => sql.startsWith("SELECT "))).toBe(true);
      for (const name of PUBLISHED_CLOUD_DATA_TABLES)
        expect(f.db.query(`SELECT COUNT(*) AS count FROM ${name}`).get()).toEqual({ count: 0 });
      expect(f.db.query("SELECT version FROM cloud_schema").get()).toEqual({ version: 1 });
      expect(f.db.query("SELECT id FROM unrelated").get()).toEqual({ id: "preserved" });
    } finally {
      f.db.close();
    }
  });

  it("uses restored schema tables, including score summaries, but preserves migrations and unrelated rows", async () => {
    const names = [
      "events",
      "teams",
      "deployments",
      "score_summary",
      "leaderboard_snapshots",
      "control_data_migrations",
      "unrelated",
    ];
    const f = fixture(
      names.flatMap((name) => [
        `CREATE TABLE ${name} (id TEXT)`,
        `INSERT INTO ${name} VALUES ('preserved')`,
      ]),
    );
    try {
      await resetKnownTursoData(f.client, "lite-baseline-v1");
      for (const name of names)
        expect(f.db.query(`SELECT id FROM ${name}`).all()).toHaveLength(
          ["control_data_migrations", "unrelated"].includes(name) ? 1 : 0,
        );
      expect(f.calls.some((sql) => /CREATE|DROP|ALTER/u.test(sql))).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it("rejects cloud-v1 tables when the deployed composition is restored", async () => {
    const f = fixture([
      "CREATE TABLE cloud_events (id TEXT)",
      "INSERT INTO cloud_events VALUES ('kept')",
    ]);
    try {
      await expect(resetKnownTursoData(f.client, "lite-baseline-v1")).rejects.toThrow("cloud-v1");
      expect(f.calls.every((sql) => sql.startsWith("SELECT "))).toBe(true);
    } finally {
      f.db.close();
    }
  });
  it("keeps explicit published cloud-v1 recovery isolated from restored and unrelated tables", async () => {
    const f = fixture([
      "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)",
      "INSERT INTO cloud_schema VALUES (1, 1)",
      "CREATE TABLE cloud_transaction_guard (id INTEGER PRIMARY KEY, valid INTEGER CHECK(valid=1))",
      ...["cloud_events", "events", "unrelated", "cloud_unknown"].flatMap((name) => [
        `CREATE TABLE ${name} (id TEXT)`,
        `INSERT INTO ${name} VALUES ('kept')`,
      ]),
    ]);
    try {
      await resetKnownTursoData(f.client, "cloud-v1");
      expect(f.db.query("SELECT * FROM cloud_events").all()).toEqual([]);
      for (const name of ["events", "unrelated", "cloud_unknown"])
        expect(f.db.query(`SELECT * FROM ${name}`).all()).toHaveLength(1);
      expect(f.db.query("SELECT version FROM cloud_schema").get()).toEqual({ version: 1 });
    } finally {
      f.db.close();
    }
  });
  it("refuses unknown published schema versions before any writes", async () => {
    const f = fixture([
      "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY, version INTEGER)",
      "INSERT INTO cloud_schema VALUES (1, 2)",
    ]);
    try {
      await expect(resetKnownTursoData(f.client, "cloud-v1")).rejects.toThrow(
        "Unknown published cloud-v1 schema version",
      );
      expect(f.calls.every((sql) => sql.startsWith("SELECT "))).toBe(true);
    } finally {
      f.db.close();
    }
  });
});
