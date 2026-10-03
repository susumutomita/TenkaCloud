import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { SCORE_SUMMARY_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/score-summary-schema";
import { ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-admin-audit-log-repository";
import { COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-competitor-accounts-repository";
import { DEPLOYMENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-deployments-core";
import { DISRUPTIONS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-disruptions-repository";
import { EVENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-events-repository";
import { FEATURE_FLAGS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-feature-flags-repository";
import { NOTIFICATIONS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-notifications-repository";
import { PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-problem-endpoints-repository";
import { SAML_CONFIG_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-saml-config-repository";
import { SAML_IDPS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-saml-idps-repository";
import { TEAMS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-teams-repository";
import {
  CLOUD_TURSO_COMPETITION_TABLES,
  LITE_TURSO_COMPETITION_TABLES,
} from "./turso-clear-tables";
import { LITE_TURSO_DATA_TABLES, type TursoResetSql } from "./turso-reset";
import { clearTursoControlData, type TursoResetOptions } from "./turso-reset-command";
import { PUBLISHED_CLOUD_DATA_TABLES } from "./turso-schema";

const lite = [
  ...SCORE_SUMMARY_SCHEMA_STATEMENTS,
  ...ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS,
  ...COMPETITOR_ACCOUNTS_SCHEMA_STATEMENTS,
  ...DEPLOYMENTS_SCHEMA_STATEMENTS,
  ...DISRUPTIONS_SCHEMA_STATEMENTS,
  ...EVENTS_SCHEMA_STATEMENTS,
  ...FEATURE_FLAGS_SCHEMA_STATEMENTS,
  ...NOTIFICATIONS_SCHEMA_STATEMENTS,
  ...PROBLEM_ENDPOINTS_SCHEMA_STATEMENTS,
  ...SAML_CONFIG_SCHEMA_STATEMENTS,
  ...SAML_IDPS_SCHEMA_STATEMENTS,
  ...TEAMS_SCHEMA_STATEMENTS,
].filter((sql) => sql.trim().startsWith("CREATE "));
const cloud = [
  "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
  "CREATE TABLE cloud_transaction_guard (id INTEGER PRIMARY KEY CHECK(id=1), valid INTEGER NOT NULL CHECK(valid=1))",
  "CREATE TABLE cloud_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  "CREATE TABLE cloud_teams (event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(event_id,team_id))",
  "CREATE TABLE cloud_deployments (job_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, team_id TEXT NOT NULL, problem_id TEXT NOT NULL, payload TEXT NOT NULL)",
  ...PUBLISHED_CLOUD_DATA_TABLES.filter(
    (name) =>
      !["cloud_transaction_guard", "cloud_events", "cloud_teams", "cloud_deployments"].includes(
        name,
      ),
  ).map((name) => `CREATE TABLE "${name}" (payload TEXT NOT NULL)`),
];

function fixture(schema: readonly string[]) {
  const db = new Database(":memory:");
  for (const sql of [...schema, "CREATE TABLE unrelated (id TEXT PRIMARY KEY)"]) db.run(sql);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    const columns = db.query(`PRAGMA table_info("${name}")`).all() as {
      name: string;
      type: string;
    }[];
    const names = columns.map((column) => `"${column.name}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((column) => {
      if (column.type === "INTEGER") return 1;
      return column.name === "payload" ? "{}" : "synthetic";
    });
    db.query(`INSERT INTO "${name}" (${names}) VALUES (${placeholders})`).run(...values);
  }
  const output: string[] = [];
  let batches = 0;
  const client: TursoResetSql = {
    execute: async (sql) => ({ rows: db.query(sql).all() as Record<string, unknown>[] }),
    batch: async (statements, mode) => {
      expect(mode).toBe("write");
      batches++;
      db.transaction(() => {
        for (const { sql } of statements) db.run(sql);
      })();
    },
  };
  const run = (options: Partial<TursoResetOptions> = {}) =>
    clearTursoControlData(
      client,
      {
        plan: false,
        yes: false,
        confirm: async () => false,
        output: (text) => output.push(text),
        ...options,
      },
      "competition",
    );
  const snapshot = () => db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  const rows = (table: string) => db.query(`SELECT * FROM "${table}"`).all();
  return {
    db,
    tables: tables.map(({ name }) => name),
    client,
    output,
    run,
    snapshot,
    rows,
    batches: () => batches,
  };
}

describe("competition-only Turso clear uses the existing SQLite safety guards", () => {
  for (const [name, schema, cleared] of [
    ["Lite", lite, LITE_TURSO_COMPETITION_TABLES],
    ["cloud-v1", cloud, CLOUD_TURSO_COMPETITION_TABLES],
  ] as const) {
    it(`clears every ${name} competition table atomically while preserving settings, audit, migrations and schema`, async () => {
      const f = fixture(schema);
      try {
        const before = f.snapshot();
        const preserved = new Map(
          f.tables
            .filter((table) => !(cleared as readonly string[]).includes(table))
            .map((table) => [table, f.rows(table)]),
        );
        await f.run({ yes: true });
        expect(f.batches()).toBe(1);
        expect(f.snapshot()).toEqual(before);
        for (const table of cleared) expect(f.rows(table)).toEqual([]);
        for (const [table, rows] of preserved) expect(f.rows(table)).toEqual(rows);
        expect(f.output.join("")).toContain(`known tables: ${cleared.join(", ")}`);
        expect(f.output.join("")).toContain("competition-data clear completed");
        await f.run({ yes: true });
        for (const [table, rows] of preserved) expect(f.rows(table)).toEqual(rows);
      } finally {
        f.db.close();
      }
    });
    it(`keeps ${name} plan and cancelled confirmation read-only`, async () => {
      const f = fixture(schema);
      try {
        await f.run({
          plan: true,
          yes: true,
          confirm: async () => {
            throw new Error("Plans do not confirm");
          },
        });
        let question = "";
        await expect(
          f.run({
            confirm: async (text) => {
              question = text;
              return false;
            },
          }),
        ).rejects.toThrow("clear cancelled");
        expect(question).toContain("clear these Turso competition-data rows");
        expect(f.batches()).toBe(0);
        for (const table of f.tables) expect(f.rows(table)).toHaveLength(1);
        expect(f.output.join("")).toContain("Remaining deployment records: 1");
      } finally {
        f.db.close();
      }
    });
  }
  it("keeps the old Lite reset allowlist broader than competition-only clear", () => {
    for (const table of [
      "competitor_accounts",
      "saml_configs",
      "saml_idps",
      "tenant_feature_flags",
      "admin_audit_log",
    ]) {
      expect(LITE_TURSO_DATA_TABLES).toContain(table);
      expect(LITE_TURSO_COMPETITION_TABLES as readonly string[]).not.toContain(table);
    }
  });
  it("refuses a trigger on the cloud-v1 transaction guard before it can touch retained settings", async () => {
    const f = fixture(cloud);
    try {
      f.db.run(
        "CREATE TRIGGER guard_cleanup AFTER INSERT ON cloud_transaction_guard BEGIN DELETE FROM cloud_connections; END",
      );
      await expect(f.run({ yes: true })).rejects.toThrow("custom triggers");
      expect(f.batches()).toBe(0);
      expect(f.rows("cloud_connections")).toHaveLength(1);
      expect(f.rows("cloud_events")).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  it.each([
    "CREATE TRIGGER custom_cleanup AFTER DELETE ON events BEGIN DELETE FROM saml_configs; END",
    "CREATE TABLE retained_reference (event_id TEXT REFERENCES events(event_id) ON DELETE CASCADE)",
    "ALTER TABLE events RENAME COLUMN payload TO unrecognized",
  ])("refuses unsafe schemas or effects on preserved data: %s", async (sql) => {
    const f = fixture(lite);
    try {
      f.db.run(sql);
      await expect(f.run({ yes: true })).rejects.toThrow();
      expect(f.batches()).toBe(0);
      expect(f.rows("events")).toHaveLength(1);
      expect(f.rows("saml_configs")).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  it("rechecks changes during confirmation and preserves all rows on a failed write transaction", async () => {
    const f = fixture(lite);
    try {
      await expect(
        f.run({
          confirm: async () => {
            f.db.run("DELETE FROM deployments");
            return true;
          },
        }),
      ).rejects.toThrow("changed during confirmation");
      expect(f.batches()).toBe(0);
      const batch = f.client.batch;
      f.client.batch = async (statements, mode) =>
        batch([...statements, { sql: "DELETE FROM missing_table" }], mode);
      await expect(f.run({ yes: true })).rejects.toThrow("Turso clear did not complete");
      expect(f.batches()).toBe(1);
      expect(f.rows("events")).toHaveLength(1);
      expect(f.rows("saml_configs")).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
});
