import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { SCORE_SUMMARY_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/score-summary-schema";
import { DEPLOYMENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-deployments-core";
import { EVENTS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-events-repository";
import { TEAMS_SCHEMA_STATEMENTS } from "../../infrastructure/lib/problem-deploy/control-data/sql-teams-repository";
import type { TursoResetSql, withTursoControlData } from "./turso-reset";
import { resetSelectedTursoData, type TursoResetOptions } from "./turso-reset-command";

const target = {
  databaseUrl: "https://synthetic.turso.io",
  parameterName: "/synthetic/turso/auth-token",
  environment: "staging",
  account: "123456789012",
  region: "ap-northeast-1",
};
const lite = [
  ...EVENTS_SCHEMA_STATEMENTS,
  ...TEAMS_SCHEMA_STATEMENTS,
  ...DEPLOYMENTS_SCHEMA_STATEMENTS,
  ...SCORE_SUMMARY_SCHEMA_STATEMENTS,
].filter((sql) => sql.startsWith("CREATE"));
const liteRows = [
  "INSERT INTO events VALUES ('event', 'tenant', 'ENDED', 'now', 0, '{}')",
  "INSERT INTO teams VALUES ('event', 'team', 'tenant', NULL, 0, '{}')",
  "INSERT INTO deployments (job_id, payload) VALUES ('job', '{}')",
  "INSERT INTO score_summary VALUES ('event', 'team', 1, 1, 'now', '{}')",
  "INSERT INTO control_data_migrations VALUES ('synthetic-migration', 'now')",
];
const cloud = [
  "CREATE TABLE cloud_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
  "INSERT INTO cloud_schema VALUES (1, 1)",
  "CREATE TABLE cloud_transaction_guard (id INTEGER PRIMARY KEY CHECK(id=1), valid INTEGER NOT NULL CHECK(valid=1))",
  "CREATE TABLE cloud_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  "CREATE TABLE cloud_teams (event_id TEXT NOT NULL, team_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(event_id, team_id))",
  "CREATE TABLE cloud_deployments (job_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, team_id TEXT NOT NULL, problem_id TEXT NOT NULL, payload TEXT NOT NULL)",
];
const cloudRows = [
  "INSERT INTO cloud_transaction_guard VALUES (1, 1)",
  "INSERT INTO cloud_events VALUES ('event', '{}')",
  "INSERT INTO cloud_teams VALUES ('event', 'team', '{}')",
  "INSERT INTO cloud_deployments VALUES ('job', 'event', 'team', 'problem', '{}')",
];

function fixture(statements: readonly string[]) {
  const db = new Database(":memory:");
  for (const sql of [
    ...statements,
    "CREATE TABLE unrelated (id TEXT PRIMARY KEY)",
    "INSERT INTO unrelated VALUES ('preserved')",
  ])
    db.run(sql);
  const writes: string[] = [];
  const output: string[] = [];
  const client: TursoResetSql = {
    execute: async (sql) => ({ rows: db.query(sql).all() as Record<string, unknown>[] }),
    batch: async (statements, mode) => {
      expect(mode).toBe("write");
      db.transaction(() => {
        for (const { sql } of statements) {
          writes.push(sql);
          db.run(sql);
        }
      })();
    },
  };
  const connect: typeof withTursoControlData = async (selected, action) => {
    expect(selected).toEqual(target);
    return action(client);
  };
  const options: TursoResetOptions = {
    plan: false,
    yes: false,
    confirm: async () => false,
    output: (line) => output.push(line),
  };
  const run = (changes: Partial<TursoResetOptions> = {}) =>
    resetSelectedTursoData(target, { ...options, ...changes }, connect);
  const count = (table: string) => db.query(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const schema = () => db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  return { db, client, output, writes, run, count, schema };
}

describe("standalone Turso reset", () => {
  for (const [schema, statements, eventTable] of [
    ["lite-baseline-v1", [...lite, ...liteRows], "events"],
    ["cloud-v1", [...cloud, ...cloudRows], "cloud_events"],
  ] as const) {
    it(`previews ${schema} and deployment orphan risk without writes or confirmation`, async () => {
      const f = fixture(statements);
      try {
        await f.run({
          plan: true,
          yes: true,
          confirm: async () => {
            throw new Error("must not confirm plan");
          },
        });
        expect(f.writes).toEqual([]);
        expect(f.count(eventTable)).toEqual({ count: 1 });
        const text = f.output.join("");
        for (const expected of [
          target.databaseUrl,
          target.parameterName,
          target.environment,
          target.account,
          target.region,
          schema,
          "Remaining deployment records: 1",
          "orphan",
          "Teardown",
        ])
          expect(text).toContain(expected);
        expect(text).not.toContain("completed");
      } finally {
        f.db.close();
      }
    });
    it(`resets ${schema} atomically, preserving schema, migrations and unrelated rows on retries`, async () => {
      const f = fixture(statements);
      try {
        const before = f.schema();
        await f.run({ yes: true });
        await f.run({ yes: true });
        expect(f.schema()).toEqual(before);
        expect(f.count(eventTable)).toEqual({ count: 0 });
        expect(f.count("unrelated")).toEqual({ count: 1 });
        expect(f.count(schema === "cloud-v1" ? "cloud_schema" : "control_data_migrations")).toEqual(
          { count: 1 },
        );
        expect(f.output.join("")).toContain("reset completed");
        expect(
          f.writes.every(
            (sql) =>
              sql.startsWith("DELETE") ||
              sql.startsWith("INSERT OR REPLACE INTO cloud_transaction_guard"),
          ),
        ).toBe(true);
      } finally {
        f.db.close();
      }
    });
  }
  it("keeps declined/noninteractive execution read-only and confirms one time interactively", async () => {
    const f = fixture([...lite, ...liteRows]);
    try {
      await expect(f.run()).rejects.toThrow("cancelled");
      expect(f.writes).toEqual([]);
      expect(f.count("events")).toEqual({ count: 1 });
      let confirmations = 0;
      await f.run({
        confirm: async () => {
          confirmations++;
          return true;
        },
      });
      expect(confirmations).toBe(1);
      expect(f.count("events")).toEqual({ count: 0 });
    } finally {
      f.db.close();
    }
  });
  it("allows valid Lite rows beside known-empty retired tables", async () => {
    const f = fixture([...cloud, ...lite, ...liteRows]);
    try {
      await f.run({ yes: true });
      expect(f.count("events")).toEqual({ count: 0 });
      expect(f.count("cloud_schema")).toEqual({ count: 1 });
      expect(f.writes.every((sql) => !sql.includes("cloud_"))).toBe(true);
    } finally {
      f.db.close();
    }
  });
  it.each(
    [
      [],
      ["CREATE TABLE events (id TEXT)"],
      ...["events", "teams", "deployments"].map((name) => [
        ...lite,
        `ALTER TABLE ${name} RENAME COLUMN payload TO unrecognized`,
      ]),
      [...cloud, "UPDATE cloud_schema SET version=2"],
      [
        ...cloud,
        "DROP TABLE cloud_transaction_guard",
        "CREATE TABLE cloud_transaction_guard (id INTEGER PRIMARY KEY, valid INTEGER)",
      ],
      [...cloud, "CREATE TABLE cloud_unknown (id TEXT)"],
      [...cloud, ...cloudRows, ...lite, ...liteRows],
    ].map((statements, index) => [index + 1, statements] as const),
  )("rejects unknown or ambiguous schema without deletion: case %i", async (_case, statements) => {
    const f = fixture(statements);
    try {
      await expect(f.run({ yes: true })).rejects.toThrow();
      expect(f.writes).toEqual([]);
      expect(f.count("unrelated")).toEqual({ count: 1 });
    } finally {
      f.db.close();
    }
  });
  it.each([
    "CREATE TRIGGER custom_cleanup AFTER DELETE ON events BEGIN DELETE FROM unrelated; END",
    "CREATE TABLE external_reference (event_id TEXT REFERENCES events(event_id) ON DELETE CASCADE)",
  ])("refuses side effects into unrelated data: %s", async (sql) => {
    const f = fixture([...lite, ...liteRows, sql]);
    try {
      await expect(f.run({ yes: true })).rejects.toThrow();
      expect(f.writes).toEqual([]);
      expect(f.count("events")).toEqual({ count: 1 });
      expect(f.count("unrelated")).toEqual({ count: 1 });
    } finally {
      f.db.close();
    }
  });
  it.each([undefined, null, "", "invalid", -1, Number.NaN])(
    "rejects an unverifiable deployment count: %j",
    async (value) => {
      const f = fixture([...lite, ...liteRows]);
      try {
        const execute = f.client.execute;
        f.client.execute = (sql) =>
          sql.startsWith("SELECT COUNT(*)")
            ? Promise.resolve({ rows: [{ count: value }] })
            : execute(sql);
        await expect(f.run({ yes: true })).rejects.toThrow("count could not be verified");
        expect(f.writes).toEqual([]);
        expect(f.count("events")).toEqual({ count: 1 });
      } finally {
        f.db.close();
      }
    },
  );
  it("stops if deployment records change during confirmation", async () => {
    const f = fixture([...lite, ...liteRows]);
    try {
      await expect(
        f.run({
          confirm: async () => {
            f.db.run("INSERT INTO deployments (job_id, payload) VALUES ('second', '{}')");
            return true;
          },
        }),
      ).rejects.toThrow("changed during confirmation");
      expect(f.writes).toEqual([]);
      expect(f.count("events")).toEqual({ count: 1 });
    } finally {
      f.db.close();
    }
  });
  it("reports failed/uncertain commits honestly and never leaks SQL error contents or retries", async () => {
    const f = fixture([...lite, ...liteRows]);
    try {
      let batches = 0;
      f.client.batch = async (statements) => {
        batches++;
        f.db.transaction(() => {
          for (const { sql } of statements) f.db.run(sql);
          throw new Error("synthetic-secret-from-provider");
        })();
      };
      await expect(f.run({ yes: true })).rejects.toThrow("commit outcome unknown");
      expect(batches).toBe(1);
      expect(f.count("events")).toEqual({ count: 1 });
      expect(f.count("deployments")).toEqual({ count: 1 });
      expect(f.output.join("")).not.toContain("synthetic-secret-from-provider");
      expect(f.output.join("")).not.toContain("completed");
    } finally {
      f.db.close();
    }
  });
});
