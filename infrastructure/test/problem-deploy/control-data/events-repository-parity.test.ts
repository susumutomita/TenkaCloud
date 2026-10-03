import { describe, expect, it } from "vitest";
import {
  createEventsRepository,
  DynamoDbEventsRepository,
  type EventRecord,
  type EventsRepository,
  SqlEventsRepository,
} from "../../../lib/problem-deploy/control-data/events-repository";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * Parity suite for the Events repository seam. The SAME assertions
 * run against every backend so DynamoDB (behavior-preserving extraction) and
 * SQLite (Turso / D1 dialect) are provably interchangeable:
 *   - DynamoDb impl against a faithful in-memory fake DocumentClient (real
 *     round-trip: put → get returns the stored row).
 *   - Sql impl against Node's built-in `node:sqlite` DatabaseSync (`:memory:`),
 *     so no new dependency is introduced.
 */

const TABLE = "Events";

function sampleRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    name: "Spring Cup",
    status: "DRAFT",
    problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800, // 2100-01-01, comfortably unexpired
    ...overrides,
  };
}

const backends: ReadonlyArray<readonly [string, () => EventsRepository]> = [
  ["DynamoDbEventsRepository", () => new DynamoDbEventsRepository(makeFakeDdb(), TABLE)],
  ["SqlEventsRepository", () => new SqlEventsRepository(makeSqliteExecutor())],
];

describe.each(backends)("EventsRepository parity: %s", (_name, makeRepo) => {
  it("should round-trip putEvent then getEvent identically", async () => {
    const repo = makeRepo();
    const record = sampleRecord({
      status: "READY",
      startsAt: "2026-06-01T09:00:00.000Z",
      scoringLocked: true,
      progressionGate: { gateProblemId: "p1", unlockTargetIds: ["p2"] },
    });
    await repo.putEvent(record);
    expect(await repo.getEvent(record.tenantId, record.eventId)).toEqual(record);
  });

  it("should return undefined for a missing event", async () => {
    const repo = makeRepo();
    expect(await repo.getEvent("tenant-a", "does-not-exist")).toBeUndefined();
  });

  it("should return undefined on a tenant mismatch (no cross-tenant leak)", async () => {
    const repo = makeRepo();
    const record = sampleRecord();
    await repo.putEvent(record);
    expect(await repo.getEvent("tenant-b", record.eventId)).toBeUndefined();
  });

  it("should upsert (second putEvent overwrites the first)", async () => {
    const repo = makeRepo();
    await repo.putEvent(sampleRecord({ name: "v1" }));
    await repo.putEvent(sampleRecord({ name: "v2", status: "READY" }));
    const got = await repo.getEvent("tenant-a", "01EVENTAAAAAAAAAAAAAAAAAAA");
    expect(got?.name).toBe("v2");
    expect(got?.status).toBe("READY");
  });

  it("should delete an event idempotently", async () => {
    const repo = makeRepo();
    const record = sampleRecord();
    await repo.putEvent(record);
    await repo.deleteEvent(record.eventId);
    await repo.deleteEvent(record.eventId);
    expect(await repo.getEvent(record.tenantId, record.eventId)).toBeUndefined();
  });

  it("should list a tenant's events newest-first by createdAt", async () => {
    const repo = makeRepo();
    await repo.putEvent(sampleRecord({ eventId: "e-old", createdAt: "2026-06-01T00:00:00.000Z" }));
    await repo.putEvent(sampleRecord({ eventId: "e-new", createdAt: "2026-06-03T00:00:00.000Z" }));
    await repo.putEvent(sampleRecord({ eventId: "e-mid", createdAt: "2026-06-02T00:00:00.000Z" }));
    const listed = await repo.listEventsByTenant("tenant-a");
    expect(listed.map((r) => r.eventId)).toEqual(["e-new", "e-mid", "e-old"]);
  });

  it("should not list another tenant's events", async () => {
    const repo = makeRepo();
    await repo.putEvent(sampleRecord({ eventId: "a1", tenantId: "tenant-a" }));
    await repo.putEvent(sampleRecord({ eventId: "b1", tenantId: "tenant-b" }));
    const listed = await repo.listEventsByTenant("tenant-a");
    expect(listed.map((r) => r.eventId)).toEqual(["a1"]);
  });

  it("should return an empty list for a tenant with no events", async () => {
    const repo = makeRepo();
    expect(await repo.listEventsByTenant("tenant-empty")).toEqual([]);
  });

  it("should prune expired events, keeping unexpired and TTL-less rows", async () => {
    const repo = makeRepo();
    await repo.putEvent(sampleRecord({ eventId: "e-expired", expiresAt: 1000 }));
    await repo.putEvent(sampleRecord({ eventId: "e-fresh", expiresAt: 5000 }));
    await repo.putEvent(sampleRecord({ eventId: "e-ttlless", expiresAt: 0 }));

    const deleted = await repo.pruneExpired(2000);

    expect(deleted).toBe(1);
    expect(await repo.getEvent("tenant-a", "e-expired")).toBeUndefined();
    expect(await repo.getEvent("tenant-a", "e-fresh")).toBeDefined();
    expect(await repo.getEvent("tenant-a", "e-ttlless")).toBeDefined();
  });

  it("should prune nothing when no event is expired", async () => {
    const repo = makeRepo();
    await repo.putEvent(sampleRecord({ eventId: "e-fresh", expiresAt: 5000 }));
    expect(await repo.pruneExpired(2000)).toBe(0);
  });
});

describe("createEventsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), eventsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createEventsRepository(undefined, ddbDeps())).toBeInstanceOf(DynamoDbEventsRepository);
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createEventsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(DynamoDbEventsRepository);
  });

  it("should select the SQL backend for the turso flag", () => {
    const sql = makeSqliteExecutor();
    expect(createEventsRepository("turso", { sql })).toBeInstanceOf(SqlEventsRepository);
  });

  it("should build a working SQL repository through the factory", async () => {
    const repo = createEventsRepository("turso", { sql: makeSqliteExecutor() });
    const record = sampleRecord();
    await repo.putEvent(record);
    expect(await repo.getEvent(record.tenantId, record.eventId)).toEqual(record);
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createEventsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createEventsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createEventsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });

  it("should reject an unknown backend value", () => {
    for (const value of ["postgres", "sql", "turso-mirror", "sql-mirror"]) {
      expect(() => createEventsRepository(value, ddbDeps())).toThrow(
        /Unknown CONTROL_DATA_BACKEND.*expected one of: dynamodb, turso/,
      );
    }
  });
});
