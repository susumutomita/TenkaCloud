import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createClient as createLocalClient } from "@libsql/client";
import { type Client, createClient } from "@libsql/client/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBackend } from "../../lib/problem-deploy/control-data/backend-config.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import {
  createDefaultSqlExecutorCache,
  createSqlExecutorCache,
  type RuntimeDependencies,
} from "../../lib/problem-deploy/control-data/sql-executor-cache.js";
import { resetControlData } from "../../lib/problem-deploy/control-data/sql-reset.js";
import {
  sqlChangesGuard,
  sqlCommit,
  sqlGuard,
} from "../../lib/problem-deploy/control-data/sql-transaction.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function httpFixture() {
  const fixture = sqlHttpFixture();
  cleanup.push(fixture.close);
  return fixture;
}
const environment = {
  CONTROL_DATA_BACKEND: "turso",
  TURSO_DATABASE_URL: "libsql://fixture.invalid",
  TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/turso/auth-token",
};
function cacheFixture() {
  const f = httpFixture();
  const send = vi
    .fn()
    .mockResolvedValue({ Parameter: { Type: "SecureString", Value: " synthetic-token " } });
  const factory = vi.fn().mockReturnValue(f.client);
  const deps: RuntimeDependencies = {
    env: environment,
    ssm: { send } as unknown as SSMClient,
    createClient: factory,
  };
  return { ...f, deps, send, factory, acquire: createSqlExecutorCache(deps) };
}

describe("restored cloud backend choice", () => {
  it.each([undefined, "", "  ", "DynamoDB"])("keeps DynamoDB default: %s", (value) =>
    expect(selectBackend({ CONTROL_DATA_BACKEND: value })).toEqual({ kind: "dynamodb" }),
  );
  it("accepts Turso and rejects legacy aliases instead of changing storage silently", () => {
    expect(selectBackend({ CONTROL_DATA_BACKEND: " Turso " })).toEqual({ kind: "turso" });
    for (const value of ["sql", "sqlite", "pure", "mirror", "other"])
      expect(() => selectBackend({ CONTROL_DATA_BACKEND: value })).toThrow(
        "expected one of: dynamodb, turso",
      );
  });
});

describe("production libSQL HTTP executor against in-memory SQLite", () => {
  it("maps bind parameters, reads and affected-row counts through the real HTTP client", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    await sql.run("CREATE TABLE sample (id TEXT PRIMARY KEY, value INTEGER, optional TEXT)");
    expect(await sql.run("INSERT INTO sample VALUES (?, ?, ?)", ["one", 7, null])).toEqual({
      changes: 1,
    });
    expect(await sql.get("SELECT * FROM sample WHERE id = ?", ["one"])).toMatchObject({
      id: "one",
      value: 7,
      optional: null,
    });
    expect(await sql.all("SELECT id FROM sample")).toEqual([{ id: "one" }]);
    expect(await sql.get("SELECT id FROM sample WHERE id = ?", ["absent"])).toBeUndefined();
    expect(
      await sql.all("UPDATE sample SET value = value + 1 WHERE id = ? RETURNING value", ["one"]),
    ).toEqual([{ value: 8 }]);
  });
  it("bootstraps one current schema atomically and reruns without changing records", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    await sql.run("INSERT INTO cloud_events VALUES ('fixture', '{\"retained\":true}')");
    await initializeControlDataSchema(f.client);
    expect(await sql.get("SELECT payload FROM cloud_events")).toEqual({
      payload: '{"retained":true}',
    });
    expect(await sql.get("SELECT version FROM cloud_schema")).toEqual({ version: 1 });
    expect(
      (await sql.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name),
    ).toEqual(
      expect.arrayContaining(["cloud_deployments", "cloud_coordination_runs", "cloud_connections"]),
    );
    const batches = f.requests.filter((request) => request.type === "batch");
    expect(batches).toHaveLength(5);
    expect(batches[0]?.batch.steps[0]?.stmt.sql).toBe("BEGIN IMMEDIATE");
    await sql.run("UPDATE cloud_schema SET version = 999");
    await expect(initializeControlDataSchema(f.client)).rejects.toThrow(
      "Unsupported cloud control-data schema",
    );
  });
  it("routes get/all in one primary write batch, without changing the routing row", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    for (const read of [
      () => sql.get("SELECT ? AS value", ["one"]),
      () => sql.all("SELECT ? AS value", ["two"]),
    ]) {
      const before = f.httpRequests.length;
      const beforeStatements = f.executedStatements.length;
      await read();
      expect(f.httpRequests).toHaveLength(before + 1);
      expect(f.executedStatements.slice(beforeStatements, beforeStatements + 3)).toEqual([
        "BEGIN IMMEDIATE",
        "UPDATE cloud_schema SET version = version WHERE 0",
        "SELECT ? AS value",
      ]);
    }
    expect(f.db.prepare("SELECT version FROM cloud_schema WHERE id = 1").get()).toEqual({
      version: 1,
    });
    expect(f.db.prepare("SELECT total_changes() AS count").get()).toEqual({ count: 1 });
  });
  it("propagates authoritative read failures instead of returning missing rows", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    await expect(sql.get("SELECT * FROM missing_table")).rejects.toMatchObject({
      code: "SQLITE_ERROR",
    });
    await expect(sql.all("SELECT * FROM missing_table")).rejects.toMatchObject({
      code: "SQLITE_ERROR",
    });
    const incomplete = new LibsqlExecutor({
      execute: vi.fn(),
      batch: vi.fn().mockResolvedValue([]),
    });
    await expect(incomplete.get("SELECT 1")).rejects.toThrow(
      "Missing authoritative SQL query result",
    );
  });
  it("rolls back zero-row CAS and key collisions using actual HTTP error shapes", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    expect(
      await sqlCommit(sql, [
        { sql: "INSERT INTO cloud_events VALUES ('one', '{}')" },
        { sql: "UPDATE cloud_events SET payload = '{}' WHERE event_id = 'absent'" },
        sqlChangesGuard(),
        { sql: "INSERT INTO cloud_events VALUES ('two', '{}')" },
      ]),
    ).toBe(false);
    expect(await sql.all("SELECT * FROM cloud_events")).toEqual([]);
    await sql.run("INSERT INTO cloud_events VALUES ('one', '{}')");
    expect(
      await sqlCommit(sql, [
        { sql: "INSERT INTO cloud_events VALUES ('two', '{}')" },
        { sql: "INSERT INTO cloud_events VALUES ('one', '{}')" },
      ]),
    ).toBe(false);
    expect(await sql.all("SELECT event_id FROM cloud_events")).toEqual([{ event_id: "one" }]);
  });
  it("also recognizes real local libSQL extended codes without native drivers in production imports", async () => {
    const client = createLocalClient({ url: "file::memory:" });
    cleanup.push(() => client.close());
    await initializeControlDataSchema(client);
    const sql = new LibsqlExecutor(client);
    expect(await sqlCommit(sql, [sqlGuard("0")])).toBe(false);
    await sql.run("INSERT INTO cloud_events VALUES ('one', '{}')");
    expect(await sqlCommit(sql, [{ sql: "INSERT INTO cloud_events VALUES ('one', '{}')" }])).toBe(
      false,
    );
    await expect(
      sql.batch([{ sql: "INSERT INTO cloud_events VALUES ('null', NULL)" }]),
    ).rejects.toMatchObject({ extendedCode: "SQLITE_CONSTRAINT_NOTNULL" });
  });
  it("propagates transport failures without treating them as conflicts", async () => {
    const error = new Error("network failed with SQLITE_CONSTRAINT in server logs");
    const client = createClient({
      url: "https://fixture.invalid",
      fetch: async () => {
        throw error;
      },
    });
    cleanup.push(() => client.close());
    await expect(sqlCommit(new LibsqlExecutor(client), [sqlGuard("1")])).rejects.toThrow(
      "network failed",
    );
  });
});

describe("SSM SecureString executor cache", () => {
  it("shares concurrent acquisition and warm invocations, fetching one exact parameter", async () => {
    const f = cacheFixture();
    const [first, second] = await Promise.all([f.acquire(), f.acquire()]);
    expect(first).toBe(second);
    expect(await f.acquire()).toBe(first);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.factory).toHaveBeenCalledExactlyOnceWith({
      url: environment.TURSO_DATABASE_URL,
      authToken: "synthetic-token",
    });
    const command = f.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect((command as GetParameterCommand).input).toEqual({
      Name: environment.TURSO_AUTH_TOKEN_PARAMETER_NAME,
      WithDecryption: true,
    });
  });
  it.each(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN_PARAMETER_NAME"] as const)(
    "rejects missing %s before SSM",
    async (name) => {
      const f = cacheFixture();
      const acquire = createSqlExecutorCache({ ...f.deps, env: { ...environment, [name]: " " } });
      await expect(acquire()).rejects.toThrow(`${name} is required`);
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("evicts failed SSM reads and reports actionable error details", async () => {
    const f = cacheFixture();
    f.send.mockRejectedValueOnce(
      Object.assign(new Error("fixture denied"), {
        name: "AccessDeniedException",
        $metadata: { httpStatusCode: 403 },
      }),
    );
    await expect(f.acquire()).rejects.toThrow("AccessDeniedException: fixture denied (HTTP 403)");
    expect(f.factory).not.toHaveBeenCalled();
    await expect(f.acquire()).resolves.toBeInstanceOf(LibsqlExecutor);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each([
    { Type: "String", Value: "synthetic-token" },
    { Type: "SecureString", Value: " " },
    undefined,
  ])("rejects absent, empty or non-SecureString tokens and retries: %j", async (parameter) => {
    const f = cacheFixture();
    f.send.mockResolvedValueOnce({ Parameter: parameter });
    await expect(f.acquire()).rejects.toThrow("Turso auth token");
    expect(f.factory).not.toHaveBeenCalled();
    await expect(f.acquire()).resolves.toBeInstanceOf(LibsqlExecutor);
  });
  it("evicts failed bootstrap and closes the rejected client before a fresh attempt", async () => {
    const f = cacheFixture();
    const close = vi.fn();
    const broken = {
      batch: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("fixture rejected"), { name: "UNAUTHORIZED" })),
      close,
    } as unknown as Client;
    f.factory.mockReturnValueOnce(broken);
    await expect(f.acquire()).rejects.toThrow("UNAUTHORIZED: fixture rejected");
    expect(close).toHaveBeenCalledOnce();
    await expect(f.acquire()).resolves.toBeInstanceOf(LibsqlExecutor);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.factory).toHaveBeenCalledTimes(2);
  });
  it.each(["client", "bootstrap"])(
    "redacts token echoes from %s initialization failures and retries",
    async (stage) => {
      const f = cacheFixture();
      const token = "synthetic-token\nsecond-line";
      f.send.mockResolvedValueOnce({ Parameter: { Type: "SecureString", Value: token } });
      const error = new Error(
        `invalid token ${token} quoted ${JSON.stringify(token)} encoded ${encodeURIComponent(token)}`,
      );
      if (stage === "client")
        f.factory.mockImplementationOnce(() => {
          throw error;
        });
      else
        f.factory.mockReturnValueOnce({
          batch: vi.fn().mockRejectedValue(error),
          close: vi.fn(),
        } as unknown as Client);
      const failure: unknown = await f.acquire().catch((reason) => reason);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Expected initialization failure");
      expect(failure.message).toContain("[REDACTED]");
      for (const form of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)])
        expect(failure.message).not.toContain(form);
      await expect(f.acquire()).resolves.toBeInstanceOf(LibsqlExecutor);
    },
  );
  it("ignores configured endpoint overrides when creating the production SSM client", async () => {
    const f = httpFixture();
    const endpointSettings: boolean[] = [];
    vi.spyOn(SSMClient.prototype, "send").mockImplementation(function (this: SSMClient) {
      endpointSettings.push(this.config.ignoreConfiguredEndpointUrls);
      return Promise.resolve({ Parameter: { Type: "SecureString", Value: "synthetic-token" } });
    } as SSMClient["send"]);
    vi.stubGlobal("fetch", f.fetch);
    try {
      await createDefaultSqlExecutorCache(environment)();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(endpointSettings).toEqual([true]);
  });
});

describe("explicit current SQL data reset", () => {
  it("atomically clears owned records and stop markers, preserving schema and unrelated/legacy rows", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    await sql.run("CREATE TABLE events (id TEXT)");
    await sql.run("INSERT INTO events VALUES ('legacy-lite')");
    await sql.run("CREATE TABLE another_application (id TEXT)");
    await sql.run("INSERT INTO another_application VALUES ('unrelated')");
    await sql.run("INSERT INTO cloud_events VALUES ('one', '{}')");
    await sql.run("INSERT INTO cloud_installation_control VALUES (1, '{}')");
    await sql.run("INSERT INTO cloud_coordination_runs VALUES ('event', 'problem', '{}', '{}')");
    await resetControlData(sql);
    expect(await sql.all("SELECT * FROM cloud_events")).toEqual([]);
    expect(await sql.all("SELECT * FROM cloud_installation_control")).toEqual([]);
    expect(await sql.all("SELECT * FROM cloud_coordination_runs")).toEqual([]);
    expect(await sql.get("SELECT version FROM cloud_schema")).toEqual({ version: 1 });
    expect(await sql.get("SELECT * FROM events")).toEqual({ id: "legacy-lite" });
    expect(await sql.get("SELECT * FROM another_application")).toEqual({ id: "unrelated" });
    await resetControlData(sql);
    await initializeControlDataSchema(f.client);
  });
  it("rolls back earlier deletions when any owned-table deletion fails", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    const sql = new LibsqlExecutor(f.client);
    await sql.run("INSERT INTO cloud_events VALUES ('one', '{}')");
    await sql.run("INSERT INTO cloud_teams VALUES ('one', 'team', '{}')");
    await sql.run(
      "CREATE TRIGGER fail_reset BEFORE DELETE ON cloud_teams BEGIN SELECT RAISE(ABORT, 'fixture reset failed'); END",
    );
    await expect(resetControlData(sql)).rejects.toThrow("fixture reset failed");
    expect(await sql.all("SELECT event_id FROM cloud_events")).toEqual([{ event_id: "one" }]);
    expect(await sql.all("SELECT team_id FROM cloud_teams")).toEqual([{ team_id: "team" }]);
  });
});
