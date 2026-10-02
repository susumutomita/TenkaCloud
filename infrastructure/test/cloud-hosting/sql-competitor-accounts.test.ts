import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import type { CompetitorAccountRecord } from "../../lib/problem-deploy/control-data/domain/competitor-accounts.js";
import type { DeploymentConnection } from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import {
  SqlCompetitorAccountsRepository,
  sqlRegisteredAccountGuard,
} from "../../lib/problem-deploy/control-data/sql-competitor-accounts-repository.js";
import type { SqlExecutor, SqlStatement } from "../../lib/problem-deploy/control-data/sql-port.js";
import { sqlCommit } from "../../lib/problem-deploy/control-data/sql-transaction.js";
import { sqliteFixture } from "./sql-fixture.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

const AT = "2026-10-01T12:00:00.000Z";
const NOW = Date.parse(AT);
const PARAMETER =
  "arn:aws:ssm:us-east-1:210987654321:parameter/tenkacloud/cloud/synthetic/external-id";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function account(overrides: Partial<CompetitorAccountRecord> = {}): CompetitorAccountRecord {
  return {
    awsAccountId: "123456789012",
    region: "us-east-1",
    competitorRoleName: "TenkaCloud-synthetic-deploy-Role",
    verified: false,
    createdAt: AT,
    updatedAt: AT,
    createdBy: "synthetic-organizer",
    registrationId: ulid(),
    revision: 1,
    ...overrides,
  };
}
function scope(record: CompetitorAccountRecord) {
  const event: EventRecord = {
    eventId: ulid(),
    name: "Synthetic event",
    status: "READY",
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    teamCount: 1,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 60,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "synthetic-team",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  const connection: DeploymentConnection = {
    eventId: event.eventId,
    teamId: team.teamId,
    accountId: record.awsAccountId,
    region: record.region,
    roleArn: `arn:aws:iam::${record.awsAccountId}:role/${record.competitorRoleName}`,
    externalIdParameter: PARAMETER,
    bindingId: `account-${record.registrationId.toLowerCase()}`,
    registrationId: record.registrationId,
    version: 1,
    verifiedAt: AT,
    reviewedProblemIds: ["hello-world"],
  };
  return { record, event, team, connection, now: NOW };
}
async function fixture(driver: "sqlite" | "http" = "sqlite") {
  let sql: SqlExecutor;
  if (driver === "http") {
    const f = sqlHttpFixture();
    cleanups.push(f.close);
    await initializeControlDataSchema(f.client);
    sql = new LibsqlExecutor(f.client);
  } else {
    const f = sqliteFixture();
    cleanups.push(f.close);
    sql = f.sql;
  }
  return { sql, accounts: new SqlCompetitorAccountsRepository(sql) };
}
async function registered(driver: "sqlite" | "http" = "sqlite") {
  const f = await fixture(driver);
  await f.accounts.observeExternalId(PARAMETER);
  const input = account();
  expect(await f.accounts.createAccount(input)).toBe("created");
  const record = await f.accounts.setVerified(input, true, AT);
  if (!record) throw new Error("Missing verified fixture account");
  const source = scope(record);
  await seedScope(f.sql, source.event, source.team);
  return { ...f, ...source };
}
async function seedScope(sql: SqlExecutor, event: EventRecord, team: TeamRecord) {
  await sql.batch([
    {
      sql: "INSERT INTO cloud_events (event_id, payload) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload",
      params: [event.eventId, JSON.stringify(event)],
    },
    {
      sql: "INSERT INTO cloud_teams (event_id, team_id, payload) VALUES (?, ?, ?)",
      params: [event.eventId, team.teamId, JSON.stringify(team)],
    },
  ]);
}
async function current(f: Awaited<ReturnType<typeof registered>>) {
  const record = await f.accounts.getAccount(f.record.awsAccountId);
  if (!record) throw new Error("Missing fixture account");
  return record;
}

describe.each(["sqlite", "http"] as const)(
  "competitor accounts using %s transactions",
  (driver) => {
    it("registers only after initialization, rejects duplicates, and preserves verification post-images", async () => {
      const f = await fixture(driver);
      const record = account();
      expect(await f.accounts.createAccount(record)).toBe("conflict");
      expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(true);
      expect(await f.accounts.createAccount(record)).toBe("conflict");
      await f.accounts.observeExternalId(PARAMETER);
      expect(await f.accounts.createAccount(record)).toBe("created");
      expect(await f.accounts.createAccount(account())).toBe("conflict");
      const verified = await f.accounts.setVerified(record, true, AT);
      expect(verified).toEqual({ ...record, verified: true, verifiedAt: AT, revision: 2 });
      expect(await f.accounts.setVerified(record, true, AT)).toBeUndefined();
      if (!verified) throw new Error("Missing verified account");
      const revoked = await f.accounts.setVerified(verified, false, AT);
      expect(revoked).toEqual({ ...record, revision: 3 });
      expect(await f.accounts.listAccounts()).toEqual([revoked]);
      expect(await f.accounts.getAccount("999999999999")).toBeUndefined();
      await expect(f.accounts.createAccount({ ...record, verified: true })).rejects.toThrow(
        "unverified",
      );
    });

    it("rolls back account revision and reference when the connection version conflicts", async () => {
      const f = await registered(driver);
      const existing = { ...f.connection, version: 3 };
      await f.sql.run(
        "INSERT INTO cloud_connections (event_id, team_id, payload) VALUES (?, ?, ?)",
        [f.event.eventId, f.team.teamId, JSON.stringify(existing)],
      );
      expect(await f.accounts.saveConnection(f)).toBe("conflict");
      expect(await current(f)).toEqual(f.record);
      expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toEqual([]);
      expect(
        await f.accounts.saveConnection({
          ...f,
          previousVersion: 1,
          connection: { ...f.connection, version: 2 },
        }),
      ).toBe("conflict");
      expect(await current(f)).toEqual(f.record);
      expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toEqual([]);
      expect(
        JSON.parse(String((await f.sql.get("SELECT payload FROM cloud_connections"))?.payload)),
      ).toEqual(existing);
      expect(
        await f.accounts.saveConnection({
          ...f,
          previousVersion: 3,
          connection: { ...f.connection, version: 4 },
        }),
      ).toBe("saved");
      expect((await current(f)).revision).toBe(f.record.revision + 1);
    });

    it("preserves separate references when one account serves different team regions", async () => {
      const f = await registered(driver);
      expect(await f.accounts.saveConnection(f)).toBe("saved");
      const team = {
        ...f.team,
        teamId: ulid(),
        awsAccountId: f.record.awsAccountId,
        region: "ap-northeast-1",
      };
      const connection = { ...f.connection, teamId: team.teamId, region: team.region };
      await seedScope(f.sql, f.event, team);
      expect(
        await f.accounts.saveConnection({ ...f, record: await current(f), team, connection }),
      ).toBe("saved");
      expect(
        await f.sql.all(
          "SELECT account_id, event_id, team_id FROM cloud_competitor_references ORDER BY team_id",
        ),
      ).toEqual(
        [
          { account_id: f.record.awsAccountId, event_id: f.event.eventId, team_id: f.team.teamId },
          { account_id: f.record.awsAccountId, event_id: f.event.eventId, team_id: team.teamId },
        ].sort((a, b) => a.team_id.localeCompare(b.team_id)),
      );
      expect(await f.accounts.deleteAccount(await current(f))).toBe("in_use");
      await f.sql.run("UPDATE cloud_events SET payload = ? WHERE event_id = ?", [
        JSON.stringify({
          ...f.event,
          status: "ARCHIVED",
          teardownExpected: 2,
          teardownCompleted: 2,
        }),
        f.event.eventId,
      ]);
      expect(await f.accounts.deleteAccount(await current(f))).toBe("deleted");
      expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toHaveLength(2);
      expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(false);
    });

    it("fences stale verification and connection writers across deletion and re-registration", async () => {
      const f = await registered(driver);
      expect(await f.accounts.deleteAccount(f.record)).toBe("deleted");
      const replacement = account();
      expect(await f.accounts.createAccount(replacement)).toBe("created");
      expect(await f.accounts.setVerified(f.record, true, AT)).toBeUndefined();
      expect(await f.accounts.deleteAccount(f.record)).toBe("conflict");
      expect(await f.accounts.saveConnection(f)).toBe("conflict");
      expect(await f.accounts.getAccount(replacement.awsAccountId)).toEqual(replacement);
      expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toEqual([]);
      expect(await f.sql.all("SELECT * FROM cloud_connections")).toEqual([]);
    });

    it("keeps initialization and ownership fences durable across interrupted initialization", async () => {
      const f = await fixture(driver);
      expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(true);
      const restarted = new SqlCompetitorAccountsRepository(f.sql);
      expect(await restarted.reserveExternalIdInitialization(PARAMETER)).toBe(false);
      await expect(restarted.observeExternalId(`${PARAMETER}-other`)).rejects.toThrow(
        "external_id_changed",
      );
      await restarted.observeExternalId(PARAMETER);
      await restarted.observeExternalId(PARAMETER);
      expect(await restarted.createAccount(account())).toBe("created");
      const records = await restarted.listAccounts();
      if (!records[0]) throw new Error("Missing registered fixture account");
      expect(await restarted.deleteAccount(records[0])).toBe("deleted");
      expect(await restarted.reserveExternalIdInitialization(PARAMETER)).toBe(false);
      expect(await f.sql.get("SELECT payload FROM cloud_external_id")).toMatchObject({
        payload: JSON.stringify({ parameterArn: PARAMETER, state: "INITIALIZED" }),
      });
    });
  },
);

describe("account references and registration races", () => {
  it("retains an interrupted initialization reservation after closing and reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-account-sql-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "registry.sqlite");
    const first = sqliteFixture(path);
    try {
      expect(
        await new SqlCompetitorAccountsRepository(first.sql).reserveExternalIdInitialization(
          PARAMETER,
        ),
      ).toBe(true);
    } finally {
      first.close();
    }
    const restarted = sqliteFixture(path);
    cleanups.push(restarted.close);
    const accounts = new SqlCompetitorAccountsRepository(restarted.sql);
    expect(await accounts.reserveExternalIdInitialization(PARAMETER)).toBe(false);
    await accounts.observeExternalId(PARAMETER);
    expect(await accounts.createAccount(account())).toBe("created");
  });

  it("allows only one competing first reservation", async () => {
    const f = await fixture();
    const other = new SqlCompetitorAccountsRepository(f.sql);
    expect(
      await Promise.all([
        f.accounts.reserveExternalIdInitialization(PARAMETER),
        other.reserveExternalIdInitialization(PARAMETER),
      ]),
    ).toEqual([true, false]);
  });

  it("allows only one same-revision connection writer without leaving a losing reference", async () => {
    const f = await registered();
    const team = { ...f.team, teamId: ulid() };
    await seedScope(f.sql, f.event, team);
    expect(
      await Promise.all([
        f.accounts.saveConnection(f),
        f.accounts.saveConnection({
          ...f,
          team,
          connection: { ...f.connection, teamId: team.teamId },
        }),
      ]),
    ).toEqual(["saved", "conflict"]);
    expect(await f.sql.all("SELECT team_id FROM cloud_competitor_references")).toEqual([
      { team_id: f.team.teamId },
    ]);
    expect(await f.sql.all("SELECT team_id FROM cloud_connections")).toEqual([
      { team_id: f.team.teamId },
    ]);
  });

  it("a newly saved connection fences deletion after its earlier empty reference read", async () => {
    const f = await registered();
    const interleaved: SqlExecutor = {
      ...f.sql,
      run: async (statement, params) => {
        expect(await f.accounts.saveConnection(f)).toBe("saved");
        return f.sql.run(statement, params);
      },
    };
    expect(await new SqlCompetitorAccountsRepository(interleaved).deleteAccount(f.record)).toBe(
      "conflict",
    );
    expect(await f.accounts.deleteAccount(await current(f))).toBe("in_use");
    expect(await f.sql.all("SELECT * FROM cloud_connections")).toHaveLength(1);
  });

  it("rejects a prepared deployment guard if verification changes before its transaction", async () => {
    const f = await registered();
    const guard = await sqlRegisteredAccountGuard(f.sql, f.connection);
    if (!guard) throw new Error("Missing registered account guard");
    expect(await f.accounts.setVerified(f.record, false, AT)).toBeDefined();
    expect(
      await sqlCommit(f.sql, [
        guard,
        {
          sql: "INSERT INTO cloud_deployment_receipts (receipt_key, payload) VALUES ('synthetic', '{}')",
        },
      ]),
    ).toBe(false);
    expect(await f.sql.all("SELECT * FROM cloud_deployment_receipts")).toEqual([]);
    await expect(sqlRegisteredAccountGuard(f.sql, f.connection)).rejects.toThrow(
      "competitor_account_changed",
    );
    expect(
      await sqlRegisteredAccountGuard(f.sql, { ...f.connection, registrationId: undefined }),
    ).toBeUndefined();
  });

  it.each([
    undefined,
    { status: "READY" },
    { status: "TEARDOWN", teardownExpected: 1, teardownCompleted: 1 },
    { status: "ARCHIVED" },
    { status: "ARCHIVED", teardownExpected: 2, teardownCompleted: 1 },
    { status: "ARCHIVED", teardownExpected: -1, teardownCompleted: -1 },
  ])("blocks account deletion for unresolved event state %j", async (state) => {
    const f = await registered();
    expect(await f.accounts.saveConnection(f)).toBe("saved");
    if (state)
      await f.sql.run("UPDATE cloud_events SET payload = ? WHERE event_id = ?", [
        JSON.stringify({ ...f.event, ...state }),
        f.event.eventId,
      ]);
    else await f.sql.run("DELETE FROM cloud_events WHERE event_id = ?", [f.event.eventId]);
    expect(await f.accounts.deleteAccount(await current(f))).toBe("in_use");
  });

  it.each([
    {
      table: "cloud_events",
      columns: "event_id, payload",
      values: ["synthetic", JSON.stringify({ externalIdParameter: PARAMETER })],
    },
    {
      table: "cloud_connections",
      columns: "event_id, team_id, payload",
      values: ["synthetic", "synthetic", JSON.stringify({ externalIdParameter: PARAMETER })],
    },
    {
      table: "cloud_deployments",
      columns: "job_id, event_id, team_id, problem_id, payload",
      values: [
        "synthetic",
        "synthetic",
        "synthetic",
        "synthetic",
        JSON.stringify({ connection: { externalIdParameter: PARAMETER } }),
      ],
    },
    {
      table: "cloud_deployment_attempts",
      columns: "job_id, attempt, payload",
      values: ["synthetic", 1, JSON.stringify({ connection: { externalIdParameter: PARAMETER } })],
    },
    {
      table: "cloud_competitor_references",
      columns: "account_id, event_id, team_id, payload",
      values: ["123456789012", "synthetic", "synthetic", "{}"],
    },
    {
      table: "cloud_competitor_accounts",
      columns: "account_id, payload",
      values: ["123456789012", "{}"],
    },
  ])(
    "blocks initialization when retained history exists in $table",
    async ({ table, columns, values }) => {
      const f = await fixture();
      await f.sql.run(
        `INSERT INTO ${table} (${columns}) VALUES (${values.map(() => "?").join(", ")})`,
        values,
      );
      expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(false);
      expect(await f.sql.all("SELECT * FROM cloud_external_id")).toEqual([]);
    },
  );

  it.each(["INITIALIZING", "INITIALIZED", "unknown"])(
    "never replaces an existing %s marker",
    async (state) => {
      const f = await fixture();
      await f.sql.run("INSERT INTO cloud_external_id (id, payload) VALUES (1, ?)", [
        JSON.stringify({ parameterArn: PARAMETER, state }),
      ]);
      expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(false);
      if (state === "unknown")
        await expect(f.accounts.observeExternalId(PARAMETER)).rejects.toThrow(
          "external_id_changed",
        );
    },
  );

  it("returns the existing use fence while draining but rejects a fresh reservation", async () => {
    const f = await fixture();
    await f.sql.run("INSERT INTO cloud_installation_control (id, payload) VALUES (1, '{}')");
    await expect(f.accounts.reserveExternalIdInitialization(PARAMETER)).rejects.toThrow(
      "installation_draining",
    );
    await f.accounts.observeExternalId(PARAMETER);
    expect(await f.accounts.reserveExternalIdInitialization(PARAMETER)).toBe(false);
    await expect(f.accounts.createAccount(account())).rejects.toThrow("installation_draining");
  });

  it("requires a boolean verified flag in the same transaction as connection registration", async () => {
    const f = await registered();
    await f.sql.run(
      "UPDATE cloud_competitor_accounts SET payload = json_set(payload, '$.verified', 1)",
    );
    expect(await f.accounts.saveConnection(f)).toBe("conflict");
    expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toEqual([]);
    expect(await f.sql.all("SELECT * FROM cloud_connections")).toEqual([]);
  });

  it("rechecks initialization history inside the write transaction", async () => {
    const f = await fixture();
    const interleaved: SqlExecutor = {
      ...f.sql,
      batch: async (statements) => {
        await f.sql.run(
          "INSERT INTO cloud_deployment_attempts (job_id, attempt, payload) VALUES (?, 1, ?)",
          [ulid(), JSON.stringify({ connection: { externalIdParameter: PARAMETER } })],
        );
        return f.sql.batch(statements);
      },
    };
    expect(
      await new SqlCompetitorAccountsRepository(interleaved).reserveExternalIdInitialization(
        PARAMETER,
      ),
    ).toBe(false);
    expect(await f.sql.all("SELECT * FROM cloud_external_id")).toEqual([]);
  });

  it.each(["event", "team", "intake"])("blocks writes when the %s guard closes", async (kind) => {
    const f = await registered();
    if (kind === "event")
      await f.sql.run(
        "UPDATE cloud_events SET payload = json_set(payload, '$.status', 'TEARDOWN')",
      );
    else if (kind === "team")
      await f.sql.run(
        "UPDATE cloud_teams SET payload = json_set(payload, '$.accessRevoked', json('true'))",
      );
    else await f.sql.run("INSERT INTO cloud_installation_control (id, payload) VALUES (1, '{}')");
    if (kind === "intake")
      await expect(f.accounts.saveConnection(f)).rejects.toThrow("installation_draining");
    else expect(await f.accounts.saveConnection(f)).toBe("conflict");
    expect(await current(f)).toEqual(f.record);
    expect(await f.sql.all("SELECT * FROM cloud_competitor_references")).toEqual([]);
    expect(await f.sql.all("SELECT * FROM cloud_connections")).toEqual([]);
  });

  it("fails closed on malformed payloads and mismatched reference keys", async () => {
    const f = await registered();
    await f.sql.run(
      "UPDATE cloud_competitor_accounts SET payload = json_remove(payload, '$.verifiedAt')",
    );
    await expect(f.accounts.listAccounts()).rejects.toThrow("Missing competitor verification");
    await f.sql.run("UPDATE cloud_competitor_accounts SET payload = ?", [JSON.stringify(f.record)]);
    await f.sql.run(
      "INSERT INTO cloud_competitor_references (account_id, event_id, team_id, payload) VALUES (?, ?, ?, ?)",
      [
        f.record.awsAccountId,
        f.event.eventId,
        f.team.teamId,
        JSON.stringify({
          awsAccountId: "999999999999",
          eventId: f.event.eventId,
          teamId: f.team.teamId,
          registrationId: f.record.registrationId,
        }),
      ],
    );
    await expect(f.accounts.deleteAccount(f.record)).rejects.toThrow("reference scope mismatch");
    expect(await current(f)).toEqual(f.record);
  });

  it.each([
    { connection: { roleArn: "arn:aws:iam::123456789012:role/Other" } },
    { connection: { registrationId: ulid() } },
    { connection: { bindingId: "wrong" } },
    { connection: { region: "ap-northeast-1" } },
    { team: { awsAccountId: "999999999999" } },
    { team: { region: "ap-northeast-1" } },
  ])("rejects connection scope changes before writing %j", async (change) => {
    const f = await registered();
    await expect(
      f.accounts.saveConnection({
        ...f,
        team: { ...f.team, ...change.team },
        connection: { ...f.connection, ...change.connection },
      }),
    ).rejects.toThrow("scope mismatch");
    expect(await f.sql.all("SELECT * FROM cloud_connections")).toEqual([]);
  });

  it("propagates SQL syntax, network, and unrelated constraint errors", async () => {
    const f = await fixture();
    for (const error of [
      new Error("network timeout"),
      Object.assign(new Error("no such table: synthetic"), { code: "SQLITE_ERROR" }),
      Object.assign(new Error("NOT NULL constraint failed: synthetic.payload"), {
        code: "SQLITE_CONSTRAINT_NOTNULL",
      }),
      new Error("UNIQUE constraint failed: synthetic.id"),
    ]) {
      const broken: SqlExecutor = {
        ...f.sql,
        batch: async (_statements: readonly SqlStatement[]) => {
          throw error;
        },
      };
      await expect(
        new SqlCompetitorAccountsRepository(broken).createAccount(account()),
      ).rejects.toBe(error);
      await expect(
        new SqlCompetitorAccountsRepository(broken).reserveExternalIdInitialization(PARAMETER),
      ).rejects.toBe(error);
    }
  });
});
