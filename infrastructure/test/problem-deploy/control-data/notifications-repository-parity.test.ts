import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbNotificationsRepository,
  SqlNotificationsRepository,
  type NotificationRecord,
  type NotificationsRepository,
} from "../../../lib/problem-deploy/control-data/notifications-repository";
import { MirroredNotificationsRepository } from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

const TABLE = "Events";

function sampleRecord(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    notificationId: "01NOTIFICATIONAAAAAAAAAA",
    tenantId: "tenant-a",
    title: "Notice",
    body: "Body",
    severity: "info",
    createdBy: "operator-sub",
    occurredAt: "2026-07-08T00:00:00.000Z",
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

const backends: ReadonlyArray<readonly [string, () => NotificationsRepository]> = [
  [
    "DynamoDbNotificationsRepository",
    () => new DynamoDbNotificationsRepository(makeFakeDdb(), TABLE),
  ],
  ["SqlNotificationsRepository", () => new SqlNotificationsRepository(makeSqliteExecutor())],
];

function encodeForeignCursor(): string {
  return Buffer.from(
    JSON.stringify({
      PK: "EVENT#foreign",
      SK: "NOTIFICATION#2026-07-01T00:00:00.000Z#01FOREIGN",
    }),
    "utf8",
  ).toString("base64url");
}

async function listAll(
  repo: NotificationsRepository,
  eventId: string,
): Promise<NotificationRecord[]> {
  const records: NotificationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.listByEvent(eventId, { limit: 2, cursor });
    records.push(...page.notifications);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

describe.each(backends)("NotificationsRepository parity: %s", (_name, makeRepo) => {
  it("should round-trip append then listByEvent", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ title: "Maintenance", severity: "warning" });

    await repo.append(record);

    await expect(repo.listByEvent(record.eventId, { limit: 50 })).resolves.toEqual({
      notifications: [record],
      nextCursor: undefined,
    });
  });

  it("should list newest-first by occurredAt", async () => {
    const repo = makeRepo();
    await repo.append(
      sampleRecord({
        notificationId: "01NOTIFICATIONOLD",
        occurredAt: "2026-07-08T00:00:00.000Z",
      }),
    );
    await repo.append(
      sampleRecord({
        notificationId: "01NOTIFICATIONNEW",
        occurredAt: "2026-07-08T02:00:00.000Z",
      }),
    );
    await repo.append(
      sampleRecord({
        notificationId: "01NOTIFICATIONMID",
        occurredAt: "2026-07-08T01:00:00.000Z",
      }),
    );

    const page = await repo.listByEvent("01EVENTAAAAAAAAAAAAAAAAAAA", { limit: 50 });

    expect(page.notifications.map((record) => record.notificationId)).toEqual([
      "01NOTIFICATIONNEW",
      "01NOTIFICATIONMID",
      "01NOTIFICATIONOLD",
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("should respect the limit and hand out a cursor that continues without overlap", async () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i += 1) {
      await repo.append(
        sampleRecord({
          notificationId: `01NOTIFICATIONPAGE${i}`,
          occurredAt: `2026-07-08T0${i}:00:00.000Z`,
        }),
      );
    }

    const seen = await listAll(repo, "01EVENTAAAAAAAAAAAAAAAAAAA");

    expect(seen.map((record) => record.notificationId)).toEqual([
      "01NOTIFICATIONPAGE4",
      "01NOTIFICATIONPAGE3",
      "01NOTIFICATIONPAGE2",
      "01NOTIFICATIONPAGE1",
      "01NOTIFICATIONPAGE0",
    ]);
    expect(new Set(seen.map((record) => record.notificationId)).size).toBe(5);
  });

  it("should restart from the first page on a malformed/foreign cursor", async () => {
    const repo = makeRepo();
    await repo.append(sampleRecord({ notificationId: "01NOTIFICATIONFIRST" }));

    const malformed = await repo.listByEvent("01EVENTAAAAAAAAAAAAAAAAAAA", {
      limit: 50,
      cursor: "not-a-real-cursor!!",
    });
    const foreign = await repo.listByEvent("01EVENTAAAAAAAAAAAAAAAAAAA", {
      limit: 50,
      cursor: encodeForeignCursor(),
    });

    expect(malformed.notifications.map((record) => record.notificationId)).toEqual([
      "01NOTIFICATIONFIRST",
    ]);
    expect(foreign.notifications.map((record) => record.notificationId)).toEqual([
      "01NOTIFICATIONFIRST",
    ]);
  });

  it("should not leak another event's notifications", async () => {
    const repo = makeRepo();
    await repo.append(sampleRecord({ eventId: "event-a", notificationId: "n-a" }));
    await repo.append(sampleRecord({ eventId: "event-b", notificationId: "n-b" }));

    const page = await repo.listByEvent("event-a", { limit: 50 });

    expect(page.notifications.map((record) => record.notificationId)).toEqual(["n-a"]);
  });

  it("should return an empty page without a cursor for an event with no notifications", async () => {
    const repo = makeRepo();
    const page = await repo.listByEvent("event-empty", { limit: 50 });
    expect(page.notifications).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("should overwrite on duplicate append", async () => {
    const repo = makeRepo();
    const record = sampleRecord({ title: "Before", body: "Before body" });
    await repo.append(record);
    await repo.append({ ...record, title: "After", body: "After body", severity: "warning" });

    const page = await repo.listByEvent(record.eventId, { limit: 50 });

    expect(page.notifications).toEqual([
      { ...record, title: "After", body: "After body", severity: "warning" },
    ]);
  });
});

describe("DynamoDbNotificationsRepository physical row", () => {
  it("should keep the DynamoDB notification row byte-identical to the pre-seam writer", async () => {
    const ddb = makeFakeDdb();
    const repo = new DynamoDbNotificationsRepository(ddb, TABLE);
    const record = sampleRecord();

    await repo.append(record);

    const out = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: `EVENT#${record.eventId}`,
          SK: `NOTIFICATION#${record.occurredAt}#${record.notificationId}`,
        },
      }),
    );
    expect(out.Item).toEqual({
      PK: `EVENT#${record.eventId}`,
      SK: `NOTIFICATION#${record.occurredAt}#${record.notificationId}`,
      ...record,
    });
  });
});

describe("MirroredNotificationsRepository", () => {
  function memoryNotifications(initial: readonly NotificationRecord[] = []): {
    readonly repo: NotificationsRepository;
    readonly records: Map<string, NotificationRecord>;
  } {
    const key = (record: NotificationRecord): string =>
      `${record.eventId}:${record.occurredAt}:${record.notificationId}`;
    const records = new Map(initial.map((record) => [key(record), record]));
    return {
      records,
      repo: {
        append: async (record) => {
          records.set(key(record), record);
        },
        listByEvent: async (eventId) => ({
          notifications: [...records.values()]
            .filter((record) => record.eventId === eventId)
            .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)),
        }),
      },
    };
  }

  it("should write through to both backends on append", async () => {
    const canonical = memoryNotifications();
    const replica = memoryNotifications();
    const repository = new MirroredNotificationsRepository(canonical.repo, replica.repo);
    const record = sampleRecord();

    await repository.append(record);

    expect([...canonical.records.values()]).toEqual([record]);
    expect([...replica.records.values()]).toEqual([record]);
  });

  it("should serve listByEvent from canonical only", async () => {
    const canonicalList = vi.fn(async () => ({
      notifications: [sampleRecord({ notificationId: "canonical" })],
    }));
    const replicaList = vi.fn(async () => ({
      notifications: [sampleRecord({ notificationId: "replica" })],
    }));
    const repository = new MirroredNotificationsRepository(
      { append: async () => {}, listByEvent: canonicalList },
      { append: async () => {}, listByEvent: replicaList },
    );

    const page = await repository.listByEvent("01EVENTAAAAAAAAAAAAAAAAAAA", {
      limit: 10,
      cursor: "cursor-1",
    });

    expect(page.notifications.map((record) => record.notificationId)).toEqual(["canonical"]);
    expect(canonicalList).toHaveBeenCalledWith("01EVENTAAAAAAAAAAAAAAAAAAA", {
      limit: 10,
      cursor: "cursor-1",
    });
    expect(replicaList).not.toHaveBeenCalled();
  });
});
