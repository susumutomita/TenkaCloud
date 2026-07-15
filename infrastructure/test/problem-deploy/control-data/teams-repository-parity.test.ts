import { describe, expect, it } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository";
import {
  MirroredDeploymentsRepository,
  MirroredTeamsRepository,
} from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import {
  createTeamsRepository,
  DynamoDbTeamsRepository,
  hashLoginKey,
  SqlTeamsRepository,
  TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID,
  TEAM_LOGIN_KEY_SCRUB_SQL,
  type TeamRecord,
  type TeamsRepository,
} from "../../../lib/problem-deploy/control-data/teams-repository";
import type {
  DeploymentRecord,
  DeploymentsRepository,
  SqlExecutor,
} from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [ADR-049 §5] Parity suite for the Teams repository seam. The SAME assertions run
 * against every backend so DynamoDB (behavior-preserving extraction), SQLite
 * (Turso / D1 dialect), and the mirror composition (DDB canonical + SQL replica,
 * [#2527 Slice 0] — read-repair restores the canonical login key, so callers see
 * the DynamoDB-shaped record) are provably interchangeable:
 *   - DynamoDb impl against the shared in-memory fake DocumentClient
 *     (`control-data-write.test-helpers.ts` — real round-trip: put → get returns
 *     the stored row; base-table + GSI2 queries).
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
  [
    "MirroredTeamsRepository",
    () =>
      new MirroredTeamsRepository(
        new DynamoDbTeamsRepository(makeFakeDdb(), TABLE),
        new SqlTeamsRepository(makeSqliteExecutor()),
      ),
  ],
];

function withoutLoginKey(record: TeamRecord): TeamRecord {
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = record;
  return safeRecord;
}

describe.each(backends)("TeamsRepository parity: %s", (name, makeRepo) => {
  it("should round-trip putTeam then getTeam identically", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ displayName: "Team Alpha" });
    await repo.putTeam(record);
    expect(await repo.getTeam(record.tenantId, record.eventId, record.teamId)).toEqual(
      name === "SqlTeamsRepository" ? withoutLoginKey(record) : record,
    );
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

  it("should delete a team idempotently", async () => {
    const repo = makeRepo();
    const record = sampleRecord();
    await repo.putTeam(record);
    await repo.deleteTeam(record.eventId, record.teamId);
    await repo.deleteTeam(record.eventId, record.teamId);
    expect(await repo.getTeam(record.tenantId, record.eventId, record.teamId)).toBeUndefined();
  });

  it("should list an event's teams ordered by teamId ascending", async () => {
    const repo = makeRepo();
    await repo.putTeam(sampleRecord({ teamId: "t-c", teamLoginKey: "k-c" }));
    await repo.putTeam(sampleRecord({ teamId: "t-a", teamLoginKey: "k-a" }));
    await repo.putTeam(sampleRecord({ teamId: "t-b", teamLoginKey: "k-b" }));
    const listed = await repo.listTeamsByEvent("01EVENTAAAAAAAAAAAAAAAAAAA");
    expect(listed.map((r) => r.teamId)).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("should expose a backend-neutral credential only to deployment planning", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ teamLoginKey: "DEPLOYMENT-HANDOFF-KEY" });
    await repo.putTeam(record);

    const [target] = await repo.listTeamsForDeployment(record.eventId);

    expect(target?.teamId).toBe(record.teamId);
    expect(target?.credential).toEqual(
      name === "SqlTeamsRepository"
        ? { kind: "sha256", value: hashLoginKey("DEPLOYMENT-HANDOFF-KEY") }
        : { kind: "plaintext", value: "DEPLOYMENT-HANDOFF-KEY" },
    );
    const { credential: _credential, ...metadata } = target ?? {};
    expect(JSON.stringify(metadata)).not.toContain("DEPLOYMENT-HANDOFF-KEY");
  });

  it("should reject deployment planning when a team has no login credential", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ teamLoginKey: "" });
    await repo.putTeam(record);

    await expect(repo.listTeamsForDeployment(record.eventId)).rejects.toThrow(
      /has no participant login credential/,
    );
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
    expect(await repo.getTeam(record.tenantId, record.eventId, record.teamId)).toEqual(
      withoutLoginKey(record),
    );
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
      "SELECT login_key_hash, payload FROM teams WHERE event_id = ? AND team_id = ?",
      [record.eventId, record.teamId],
    );
    expect(row?.login_key_hash).toBe(hashLoginKey(plaintext));
    expect(row?.login_key_hash).not.toBe(plaintext);
    expect(String(row?.payload)).not.toContain(plaintext);
    expect(JSON.parse(String(row?.payload))).not.toHaveProperty("teamLoginKey");
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

  it("should reject a malformed stored SQL login-key hash during deployment planning", async () => {
    const executor = makeSqliteExecutor();
    const repository = new SqlTeamsRepository(executor);
    const record = sampleRecord();
    await repository.putTeam(record);
    await executor.run("UPDATE teams SET login_key_hash = ? WHERE event_id = ? AND team_id = ?", [
      "not-a-sha256-digest",
      record.eventId,
      record.teamId,
    ]);

    await expect(repository.listTeamsForDeployment(record.eventId)).rejects.toThrow(
      /has no participant login credential/,
    );
  });

  it("should scrub a legacy plaintext login key from payloads and never return it on point reads", async () => {
    const executor = makeSqliteExecutor();
    const record = sampleRecord({ teamLoginKey: "LEGACY-PLAINTEXT" });
    await executor.run(
      `INSERT INTO teams (
         event_id, team_id, tenant_id, login_key_hash, expires_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.eventId,
        record.teamId,
        record.tenantId,
        hashLoginKey("LEGACY-PLAINTEXT"),
        record.expiresAt,
        JSON.stringify(record),
      ],
    );
    const repository = new SqlTeamsRepository(executor);

    await expect(
      repository.getTeam(record.tenantId, record.eventId, record.teamId),
    ).resolves.toEqual(withoutLoginKey(record));
    await executor.run("DELETE FROM control_data_migrations WHERE migration_id = ?", [
      TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID,
    ]);
    await executor.run(TEAM_LOGIN_KEY_SCRUB_SQL);
    const row = await executor.get("SELECT payload FROM teams WHERE event_id = ? AND team_id = ?", [
      record.eventId,
      record.teamId,
    ]);
    expect(String(row?.payload)).not.toContain("LEGACY-PLAINTEXT");
    expect(JSON.parse(String(row?.payload))).not.toHaveProperty("teamLoginKey");
  });
});

describe.each([
  [
    "DynamoDB",
    () => {
      const ddb = makeFakeDdb();
      return {
        teams: new DynamoDbTeamsRepository(ddb, "Teams", "Deployments"),
        deployments: new DynamoDbDeploymentsRepository(ddb, "Deployments"),
      };
    },
  ],
  [
    "SQL",
    () => {
      const sql = makeSqliteExecutor();
      return {
        teams: new SqlTeamsRepository(sql),
        deployments: new SqlDeploymentsRepository(sql),
      };
    },
  ],
  [
    "mirror",
    () => {
      const ddb = makeFakeDdb();
      const sql = makeSqliteExecutor();
      return {
        teams: new MirroredTeamsRepository(
          new DynamoDbTeamsRepository(ddb, "Teams", "Deployments"),
          new SqlTeamsRepository(sql),
        ),
        deployments: new MirroredDeploymentsRepository(
          new DynamoDbDeploymentsRepository(ddb, "Deployments"),
          new SqlDeploymentsRepository(sql),
        ),
      };
    },
  ],
] as const)("team login-key rotation: %s", (_name, makeRepositories) => {
  it("should invalidate the old key and rotate every deployment index", async () => {
    const { teams, deployments } = makeRepositories() as {
      teams: TeamsRepository;
      deployments: DeploymentsRepository;
    };
    const team = sampleRecord({ teamLoginKey: "OLD-TEAM-KEY" });
    const deployment: DeploymentRecord = {
      jobId: "job-1",
      problemId: "p1",
      tenantId: team.tenantId,
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      teamName: team.internalSlug,
      namePrefix: "tc-alpha-p1",
      teamLoginKey: "OLD-TEAM-KEY",
      status: "COMPLETE",
      eventId: team.eventId,
      teamId: team.teamId,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      expiresAt: team.expiresAt,
    };
    await teams.putTeam(team);
    await deployments.putDeployment(deployment);

    await expect(
      teams.rotateLoginKey({
        tenantId: team.tenantId,
        eventId: team.eventId,
        teamId: team.teamId,
        newLoginKey: "NEW-TEAM-KEY",
        updatedAt: "2026-07-15T12:00:00.000Z",
        deployments: [{ jobId: deployment.jobId, createdAt: deployment.createdAt }],
      }),
    ).resolves.toEqual({ outcome: "updated" });

    await expect(teams.getTeamByLoginKey("OLD-TEAM-KEY")).resolves.toBeUndefined();
    await expect(deployments.listByTeamLoginKey("OLD-TEAM-KEY")).resolves.toEqual([]);
    expect((await teams.getTeamByLoginKey("NEW-TEAM-KEY"))?.teamId).toBe(team.teamId);
    expect((await deployments.listByTeamLoginKey("NEW-TEAM-KEY"))[0]?.jobId).toBe("job-1");
  });

  it("should roll back the whole rotation when any deployment changed concurrently", async () => {
    const { teams } = makeRepositories() as {
      teams: TeamsRepository;
      deployments: DeploymentsRepository;
    };
    const team = sampleRecord({ teamLoginKey: "STILL-VALID-OLD-KEY" });
    await teams.putTeam(team);

    await expect(
      teams.rotateLoginKey({
        tenantId: team.tenantId,
        eventId: team.eventId,
        teamId: team.teamId,
        newLoginKey: "MUST-NOT-COMMIT",
        updatedAt: "2026-07-15T12:00:00.000Z",
        deployments: [{ jobId: "concurrently-deleted", createdAt: team.createdAt }],
      }),
    ).resolves.toEqual({ outcome: "conflict" });

    expect((await teams.getTeamByLoginKey("STILL-VALID-OLD-KEY"))?.teamId).toBe(team.teamId);
    await expect(teams.getTeamByLoginKey("MUST-NOT-COMMIT")).resolves.toBeUndefined();
  });
});

describe("DynamoDbTeamsRepository rotation errors", () => {
  const input = {
    tenantId: "tenant-a",
    eventId: "event-a",
    teamId: "team-a",
    newLoginKey: "NEW-KEY",
    updatedAt: "2026-07-15T12:00:00.000Z",
    deployments: [] as const,
  };

  it("should classify only a conditional cancellation as a conflict", async () => {
    const error = Object.assign(new Error("conditional conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    const repository = new DynamoDbTeamsRepository(
      { send: async () => Promise.reject(error) } as never,
      "Teams",
      "Deployments",
    );
    await expect(repository.rotateLoginKey(input)).resolves.toEqual({ outcome: "conflict" });
  });

  it("should require a deployments table before rotating deployment indexes", async () => {
    const repository = new DynamoDbTeamsRepository(makeFakeDdb(), "Teams");
    await expect(
      repository.rotateLoginKey({
        ...input,
        deployments: [{ jobId: "job-1", createdAt: "2026-07-15T00:00:00.000Z" }],
      }),
    ).rejects.toThrow(/requires a deployments table name/);
  });

  it("should propagate a transaction cancellation that has no cancellation reasons", async () => {
    const error = Object.assign(new Error("transaction cancelled"), {
      name: "TransactionCanceledException",
    });
    const repository = new DynamoDbTeamsRepository(
      { send: async () => Promise.reject(error) } as never,
      "Teams",
      "Deployments",
    );
    await expect(repository.rotateLoginKey(input)).rejects.toBe(error);
  });

  it("should propagate a non-Error rejection", async () => {
    const repository = new DynamoDbTeamsRepository(
      { send: async () => Promise.reject("transaction failed") } as never,
      "Teams",
      "Deployments",
    );
    await expect(repository.rotateLoginKey(input)).rejects.toBe("transaction failed");
  });

  it("should propagate capacity cancellation instead of misreporting a data conflict", async () => {
    const error = Object.assign(new Error("capacity exhausted"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
    });
    const repository = new DynamoDbTeamsRepository(
      { send: async () => Promise.reject(error) } as never,
      "Teams",
      "Deployments",
    );
    await expect(repository.rotateLoginKey(input)).rejects.toBe(error);
  });
});

describe("SqlTeamsRepository rotation errors", () => {
  const input = {
    tenantId: "tenant-a",
    eventId: "event-a",
    teamId: "team-a",
    newLoginKey: "NEW-KEY",
    updatedAt: "2026-07-15T12:00:00.000Z",
    deployments: [] as const,
  };

  function sqlWithBatchError(error: unknown): SqlExecutor {
    return {
      ...makeSqliteExecutor(),
      batch: () => {
        throw error;
      },
    };
  }

  it("should classify a libSQL extended constraint code as a conflict", async () => {
    const error = Object.assign(new Error("constraint rejected"), {
      code: "SQLITE_CONSTRAINT",
      extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
    });
    const repository = new SqlTeamsRepository(sqlWithBatchError(error));

    await expect(repository.rotateLoginKey(input)).resolves.toEqual({ outcome: "conflict" });
  });

  it("should propagate an unrelated SQL error", async () => {
    const error = new Error("database unavailable");
    const repository = new SqlTeamsRepository(sqlWithBatchError(error));

    await expect(repository.rotateLoginKey(input)).rejects.toBe(error);
  });

  it("should propagate a non-Error SQL rejection", async () => {
    const repository = new SqlTeamsRepository(sqlWithBatchError("database unavailable"));

    await expect(repository.rotateLoginKey(input)).rejects.toBe("database unavailable");
  });
});

describe("MirroredTeamsRepository rotation errors", () => {
  it("should fail loudly when the replica conflicts after the canonical update", async () => {
    const canonical = {
      rotateLoginKey: async () => ({ outcome: "updated" as const }),
    } as TeamsRepository;
    const replica = {
      rotateLoginKey: async () => ({ outcome: "conflict" as const }),
    } as TeamsRepository;
    const repository = new MirroredTeamsRepository(canonical, replica);

    await expect(
      repository.rotateLoginKey({
        tenantId: "tenant-a",
        eventId: "event-a",
        teamId: "team-a",
        newLoginKey: "NEW-KEY",
        updatedAt: "2026-07-15T12:00:00.000Z",
        deployments: [],
      }),
    ).rejects.toThrow(/replica conflict after canonical update/);
  });
});
