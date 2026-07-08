import { describe, expect, it } from "vitest";
import {
  DynamoDbEventsRepository,
  type EventRecord,
  type EventsRepository,
  SqlEventsRepository,
} from "../../../lib/problem-deploy/control-data/events-repository";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2438 / Phase A3] Parity suite for the list/scan/batch/count seam
 * methods added on top of the A1/A2 Events repository: `listEventsPage`
 * (cursor-paginated tenant listing), `listEventsByStatus` (cross-tenant
 * reconciler scan), `batchGetEvents` (scoring-meta batch read), and
 * `countEventsByTenant`. Same assertions run against both backends so
 * DynamoDB and SQLite stay provably interchangeable.
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

describe.each(backends)("EventsRepository listing/batch/count parity: %s", (_name, makeRepo) => {
  describe("listEventsPage", () => {
    it("should return the first page newest-first with a nextCursor when more remain", async () => {
      const repo = makeRepo();
      await repo.putEvent(
        sampleRecord({ eventId: "e-old", createdAt: "2026-06-01T00:00:00.000Z" }),
      );
      await repo.putEvent(
        sampleRecord({ eventId: "e-mid", createdAt: "2026-06-02T00:00:00.000Z" }),
      );
      await repo.putEvent(
        sampleRecord({ eventId: "e-new", createdAt: "2026-06-03T00:00:00.000Z" }),
      );

      const page1 = await repo.listEventsPage("tenant-a", { limit: 2 });
      expect(page1.events.map((e) => e.eventId)).toEqual(["e-new", "e-mid"]);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await repo.listEventsPage("tenant-a", {
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.events.map((e) => e.eventId)).toEqual(["e-old"]);
      expect(page2.nextCursor).toBeUndefined();
    });

    it("should not leak another tenant's events", async () => {
      const repo = makeRepo();
      await repo.putEvent(sampleRecord({ eventId: "a1", tenantId: "tenant-a" }));
      await repo.putEvent(sampleRecord({ eventId: "b1", tenantId: "tenant-b" }));

      const page = await repo.listEventsPage("tenant-a", { limit: 50 });
      expect(page.events.map((e) => e.eventId)).toEqual(["a1"]);
    });

    it("should return an empty page and no cursor for a tenant with no events", async () => {
      const repo = makeRepo();
      const page = await repo.listEventsPage("tenant-empty", { limit: 50 });
      expect(page.events).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });

    it("should restart from the first page on a malformed/foreign cursor", async () => {
      const repo = makeRepo();
      await repo.putEvent(sampleRecord({ eventId: "e1" }));
      const page = await repo.listEventsPage("tenant-a", {
        limit: 50,
        cursor: "not-a-real-cursor!!",
      });
      expect(page.events.map((e) => e.eventId)).toEqual(["e1"]);
    });
  });

  describe("listEventsByStatus", () => {
    it("should return events across tenants matching any of the given statuses", async () => {
      const repo = makeRepo();
      await repo.putEvent(
        sampleRecord({ eventId: "e-deploying", tenantId: "t1", status: "DEPLOYING" }),
      );
      await repo.putEvent(sampleRecord({ eventId: "e-ready", tenantId: "t2", status: "READY" }));
      await repo.putEvent(sampleRecord({ eventId: "e-draft", tenantId: "t1", status: "DRAFT" }));
      await repo.putEvent(
        sampleRecord({ eventId: "e-archived", tenantId: "t1", status: "ARCHIVED" }),
      );

      const matched = await repo.listEventsByStatus(["DEPLOYING", "READY"]);
      expect(new Set(matched.map((e) => e.eventId))).toEqual(new Set(["e-deploying", "e-ready"]));
    });

    it("should return an empty array for an empty statuses array", async () => {
      const repo = makeRepo();
      await repo.putEvent(sampleRecord({ status: "DEPLOYING" }));
      expect(await repo.listEventsByStatus([])).toEqual([]);
    });

    it("should return an empty array when no event matches", async () => {
      const repo = makeRepo();
      await repo.putEvent(sampleRecord({ status: "DRAFT" }));
      expect(await repo.listEventsByStatus(["ARCHIVED"])).toEqual([]);
    });
  });

  describe("batchGetEvents", () => {
    it("should return scoring meta keyed by eventId, including progressionGate when present", async () => {
      const repo = makeRepo();
      const gate = { gateProblemId: "p1", unlockTargetIds: ["p2"], defaultPolicy: "off" as const };
      await repo.putEvent(
        sampleRecord({
          eventId: "e1",
          scoringLocked: true,
          progressionGate: gate,
        }),
      );
      await repo.putEvent(sampleRecord({ eventId: "e2", scoringLocked: false }));

      const map = await repo.batchGetEvents(["e1", "e2", "does-not-exist"]);
      expect(map.size).toBe(2);
      expect(map.get("e1")).toEqual({
        scoringLocked: true,
        progressionGate: gate,
      });
      expect(map.get("e2")).toEqual({ scoringLocked: false, progressionGate: undefined });
      expect(map.has("does-not-exist")).toBe(false);
    });

    it("should return an empty map for an empty eventIds array", async () => {
      const repo = makeRepo();
      expect((await repo.batchGetEvents([])).size).toBe(0);
    });
  });

  describe("countEventsByTenant", () => {
    it("should count only a tenant's events", async () => {
      const repo = makeRepo();
      await repo.putEvent(sampleRecord({ eventId: "a1", tenantId: "tenant-a" }));
      await repo.putEvent(sampleRecord({ eventId: "a2", tenantId: "tenant-a" }));
      await repo.putEvent(sampleRecord({ eventId: "b1", tenantId: "tenant-b" }));

      expect(await repo.countEventsByTenant("tenant-a")).toBe(2);
      expect(await repo.countEventsByTenant("tenant-b")).toBe(1);
    });

    it("should return 0 for a tenant with no events", async () => {
      const repo = makeRepo();
      expect(await repo.countEventsByTenant("tenant-empty")).toBe(0);
    });
  });
});
