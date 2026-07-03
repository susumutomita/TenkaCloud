import { DatabaseSync } from "node:sqlite";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  createTeamsRepository,
  DynamoDbTeamsRepository,
  hashLoginKey,
  type SqlExecutor,
  SqlTeamsRepository,
  TEAMS_SCHEMA_SQL,
  type TeamRecord,
  type TeamsRepository,
} from "../../../lib/problem-deploy/control-data/teams-repository";

/**
 * [ADR-049 §5] Parity suite for the Teams repository seam. The SAME assertions run
 * against both backends so DynamoDB (behavior-preserving extraction) and SQLite
 * (Turso / D1 dialect) are provably interchangeable:
 *   - DynamoDb impl against a faithful in-memory fake DocumentClient (real
 *     round-trip: put → get returns the stored row; base-table + GSI2 queries).
 *   - Sql impl against Node's built-in `node:sqlite` DatabaseSync (`:memory:`),
 *     so no new dependency is introduced.
 *
 * [Issue #2290] The participant login key is stored as a SHA-256 hash in the SQL
 * backend (never as an index column plaintext); the DDB backend keeps its sparse
 * GSI2 `TEAMKEY#<plaintext>`. Both must resolve the same plaintext key to the same
 * team — asserted in the parity `getTeamByLoginKey` cases and in a focused hashing
 * suite below.
 */

const TABLE = "Teams";

/** In-memory DynamoDB document client covering the commands the repo issues. */
function makeFakeDdb(): DynamoDBDocumentClient {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;

  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command class.
  const send = async (cmd: any): Promise<unknown> => {
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      store.set(keyOf(item.PK, item.SK), item);
      return {};
    }
    if (cmd instanceof GetCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      return { Item: store.get(keyOf(key.PK, key.SK)) };
    }
    if (cmd instanceof QueryCommand) {
      const values = cmd.input.ExpressionAttributeValues ?? {};
      const pk = values[":pk"];
      if (cmd.input.IndexName === "GSI2") {
        // Participant-login lookup: GSI2PK = TEAMKEY#<key> (sparse).
        const items = [...store.values()].filter((it) => it.GSI2PK === pk);
        return { Items: items };
      }
      // base-table: PK = :pk AND begins_with(SK, :tprefix), SK 昇順 (ScanIndexForward=true).
      const prefix = String(values[":tprefix"]);
      const items = [...store.values()]
        .filter((it) => it.PK === pk && String(it.SK).startsWith(prefix))
        .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
      return { Items: items };
    }
    if (cmd instanceof ScanCommand) {
      const values = cmd.input.ExpressionAttributeValues ?? {};
      const zero = Number(values[":zero"]);
      const now = Number(values[":now"]);
      const items = [...store.values()].filter((it) => {
        const exp = Number(it.expiresAt);
        return exp > zero && exp <= now;
      });
      return { Items: items };
    }
    if (cmd instanceof DeleteCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      store.delete(keyOf(key.PK, key.SK));
      return {};
    }
    throw new Error(`FakeDdb: unsupported command ${cmd?.constructor?.name}`);
  };

  return { send } as unknown as DynamoDBDocumentClient;
}

/** node:sqlite-backed SqlExecutor (in-memory), used for the SQL parity backend. */
function makeSqliteExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  db.exec(TEAMS_SCHEMA_SQL);
  return {
    run: (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes };
    },
    get: (sql, params = []) =>
      db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    all: (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[],
  };
}

function sampleRecord(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    teamId: "01TEAMAAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    internalSlug: "alpha",
    teamLoginKey: "KEY-ALPHA",
    awsAccountId: "123456789012",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800, // 2100-01-01, comfortably unexpired
    ...overrides,
  };
}

const backends: ReadonlyArray<readonly [string, () => TeamsRepository]> = [
  ["DynamoDbTeamsRepository", () => new DynamoDbTeamsRepository(makeFakeDdb(), TABLE)],
  ["SqlTeamsRepository", () => new SqlTeamsRepository(makeSqliteExecutor())],
];

describe.each(backends)("TeamsRepository parity: %s", (_name, makeRepo) => {
  it("should round-trip putTeam then getTeam identically", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ displayName: "Team Alpha" });
    await repo.putTeam(record);
    expect(await repo.getTeam(record.tenantId, record.eventId, record.teamId)).toEqual(record);
  });

  it("should return undefined for a missing team", async () => {
    const repo = makeRepo();
    expect(await repo.getTeam("tenant-a", "e1", "does-not-exist")).toBeUndefined();
  });

  it("should return undefined on a tenant mismatch (no cross-tenant leak)", async () => {
    const repo = makeRepo();
    const record = sampleRecord();
    await repo.putTeam(record);
    expect(await repo.getTeam("tenant-b", record.eventId, record.teamId)).toBeUndefined();
  });

  it("should look up a team by its plaintext login key", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ teamLoginKey: "SHARED-PLAINTEXT-KEY" });
    await repo.putTeam(record);
    expect(await repo.getTeamByLoginKey("SHARED-PLAINTEXT-KEY")).toEqual(record);
  });

  it("should return undefined for an unknown login key", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ teamLoginKey: "REAL-KEY" }));
    expect(await repo.getTeamByLoginKey("WRONG-KEY")).toBeUndefined();
  });

  it("should upsert (second putTeam overwrites the first)", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ internalSlug: "v1" }));
    await repo.putTeam(sampleRecord({ internalSlug: "v2", displayName: "Renamed" }));
    const got = await repo.getTeam(
      "tenant-a",
      "01EVENTAAAAAAAAAAAAAAAAAAA",
      "01TEAMAAAAAAAAAAAAAAAAAAAA",
    );
    expect(got?.internalSlug).toBe("v2");
    expect(got?.displayName).toBe("Renamed");
  });

  it("should list an event's teams ordered by teamId ascending", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ teamId: "t-c", teamLoginKey: "k-c" }));
    await repo.putTeam(sampleRecord({ teamId: "t-a", teamLoginKey: "k-a" }));
    await repo.putTeam(sampleRecord({ teamId: "t-b", teamLoginKey: "k-b" }));
    const listed = await repo.listTeamsByEvent("01EVENTAAAAAAAAAAAAAAAAAAA");
    expect(listed.map((r) => r.teamId)).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("should not list another event's teams", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ eventId: "e-1", teamId: "t1", teamLoginKey: "k1" }));
    await repo.putTeam(sampleRecord({ eventId: "e-2", teamId: "t2", teamLoginKey: "k2" }));
    const listed = await repo.listTeamsByEvent("e-1");
    expect(listed.map((r) => r.teamId)).toEqual(["t1"]);
  });

  it("should return an empty list for an event with no teams", async () => {
    const repo = makeRepo();
    expect(await repo.listTeamsByEvent("e-empty")).toEqual([]);
  });

  it("should prune expired teams, keeping unexpired and TTL-less rows", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ teamId: "t-expired", teamLoginKey: "k-e", expiresAt: 1000 }));
    await repo.putTeam(sampleRecord({ teamId: "t-fresh", teamLoginKey: "k-f", expiresAt: 5000 }));
    await repo.putTeam(sampleRecord({ teamId: "t-ttlless", teamLoginKey: "k-t", expiresAt: 0 }));

    const deleted = await repo.pruneExpired(2000);

    expect(deleted).toBe(1);
    expect(
      await repo.getTeam("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "t-expired"),
    ).toBeUndefined();
    expect(await repo.getTeam("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "t-fresh")).toBeDefined();
    expect(await repo.getTeam("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA", "t-ttlless")).toBeDefined();
  });

  it("should prune nothing when no team is expired", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ teamId: "t-fresh", expiresAt: 5000 }));
    expect(await repo.pruneExpired(2000)).toBe(0);
  });
});

describe("createTeamsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), teamsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createTeamsRepository(undefined, ddbDeps())).toBeInstanceOf(DynamoDbTeamsRepository);
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createTeamsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(DynamoDbTeamsRepository);
  });

  it("should select the SQL backend for turso and sql flags", () => {
    expect(createTeamsRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlTeamsRepository,
    );
    expect(createTeamsRepository("sql", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlTeamsRepository,
    );
  });

  it("should build a working SQL repository through the factory", async () => {
    const repo = createTeamsRepository("turso", { sql: makeSqliteExecutor() });
    const record = sampleRecord();
    await repo.putTeam(record);
    expect(await repo.getTeam(record.tenantId, record.eventId, record.teamId)).toEqual(record);
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createTeamsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createTeamsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createTeamsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });

  it("should reject an unknown backend value", () => {
    expect(() => createTeamsRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });
});

describe("hashLoginKey (Issue #2290)", () => {
  it("should produce a 64-char hex SHA-256 digest", () => {
    const digest = hashLoginKey("SOME-LOGIN-KEY");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should hash two different keys to two different digests", () => {
    expect(hashLoginKey("key-one")).not.toBe(hashLoginKey("key-two"));
  });

  it("should store the login-key hash (never the plaintext) in the SQL row", async () => {
    const executor = makeSqliteExecutor();
    const repo = new SqlTeamsRepository(executor);
    const plaintext = "PLAINTEXT-BEARER";
    const record = sampleRecord({ teamLoginKey: plaintext });
    await repo.putTeam(record);

    const row = await executor.get(
      "SELECT login_key_hash FROM teams WHERE event_id = ? AND team_id = ?",
      [record.eventId, record.teamId],
    );
    expect(row?.login_key_hash).toBe(hashLoginKey(plaintext));
    expect(row?.login_key_hash).not.toBe(plaintext);
  });

  it("should store NULL in login_key_hash when the team has no login key", async () => {
    const executor = makeSqliteExecutor();
    const repo = new SqlTeamsRepository(executor);
    await repo.putTeam(sampleRecord({ teamLoginKey: "" }));

    const row = await executor.get(
      "SELECT login_key_hash FROM teams WHERE event_id = ? AND team_id = ?",
      ["01EVENTAAAAAAAAAAAAAAAAAAA", "01TEAMAAAAAAAAAAAAAAAAAAAA"],
    );
    expect(row?.login_key_hash).toBeNull();
  });
});
