import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Client } from "@libsql/client/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetKnownTursoData } from "../../../scripts/cloud-hosting/turso-reset.js";
import { assertTursoSchemaCompatible } from "../../../scripts/cloud-hosting/turso-schema.js";
import {
  initializeControlDataSchema,
  LibsqlExecutor,
} from "../../lib/problem-deploy/control-data/libsql-executor.js";
import {
  createDefaultSqlExecutorCache,
  createSqlExecutorCache,
  type RuntimeDependencies,
} from "../../lib/problem-deploy/control-data/sql-executor-cache.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) close();
});
function httpFixture() {
  const f = sqlHttpFixture();
  cleanup.push(f.close);
  return f;
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

describe("restored SQL schema through the production HTTP client", () => {
  it("checks compatibility without creating a schema, then restores the original table names", async () => {
    const f = httpFixture();
    await assertTursoSchemaCompatible(f.client);
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    await initializeControlDataSchema(f.client);
    const names = f.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(["events", "teams", "deployments", "coordination_run"]),
    );
    expect(names.some((name) => String(name).startsWith("cloud_"))).toBe(false);
    await assertTursoSchemaCompatible(f.client);
    await initializeControlDataSchema(f.client);
  });
  it("rejects a published cloud-v1 database without adopting or changing its rows", async () => {
    const f = httpFixture();
    f.db.exec(
      "CREATE TABLE cloud_events (payload TEXT); INSERT INTO cloud_events VALUES ('preserve');",
    );
    await expect(assertTursoSchemaCompatible(f.client)).rejects.toThrow("cloud-v1");
    expect(f.db.prepare("SELECT payload FROM cloud_events").get()).toEqual({ payload: "preserve" });
    expect(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get(),
    ).toBeUndefined();
  });
  it("binds values and propagates transaction rollback through actual libSQL protocol errors", async () => {
    const f = httpFixture();
    const sql = new LibsqlExecutor(f.client);
    await sql.run("CREATE TABLE rehearsal (id TEXT PRIMARY KEY, value INTEGER)");
    await sql.run("INSERT INTO rehearsal VALUES (?, ?)", ["quoted ' value", 7]);
    expect(await sql.get("SELECT * FROM rehearsal WHERE id=?", ["quoted ' value"])).toEqual({
      id: "quoted ' value",
      value: 7,
    });
    await expect(
      sql.batch([
        { sql: "INSERT INTO rehearsal VALUES ('next', 8)" },
        { sql: "INSERT INTO rehearsal VALUES (?, 9)", params: ["quoted ' value"] },
      ]),
    ).rejects.toThrow("UNIQUE");
    expect(await sql.all("SELECT id FROM rehearsal")).toEqual([{ id: "quoted ' value" }]);
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

describe("explicit restored SQL data reset", () => {
  it("clears only original competition tables, preserving migration records and unrelated data", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    f.db.exec(
      "CREATE TABLE unrelated (id TEXT); INSERT INTO unrelated VALUES ('keep'); INSERT INTO events VALUES ('event','local','DRAFT','2026-10-03T00:00:00Z',4102444800,'{}');",
    );
    await resetKnownTursoData(f.client, "lite-baseline-v1");
    expect(f.db.prepare("SELECT * FROM events").all()).toEqual([]);
    expect(f.db.prepare("SELECT * FROM unrelated").get()).toEqual({ id: "keep" });
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM control_data_migrations").get()?.count,
    ).toBeGreaterThan(0);
    await initializeControlDataSchema(f.client);
  });
  it("rolls back all deletions when a later table refuses deletion", async () => {
    const f = httpFixture();
    await initializeControlDataSchema(f.client);
    f.db.exec(
      "INSERT INTO events VALUES ('event','local','DRAFT','2026-10-03T00:00:00Z',4102444800,'{}'); CREATE TRIGGER reject_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'fixture reset failed'); END;",
    );
    await expect(resetKnownTursoData(f.client, "lite-baseline-v1")).rejects.toThrow(
      "fixture reset failed",
    );
    expect(f.db.prepare("SELECT event_id FROM events").all()).toEqual([{ event_id: "event" }]);
  });
});
