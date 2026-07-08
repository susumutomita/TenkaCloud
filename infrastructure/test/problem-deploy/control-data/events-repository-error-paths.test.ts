import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DynamoDbEventsRepository,
  type EventRecord,
  SqlEventsRepository,
} from "../../../lib/problem-deploy/control-data/events-repository";
import type { SqlExecutor } from "../../../lib/problem-deploy/control-data/types";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2437] Error-path suite for the conditional-write seam: driver errors
 * that are NOT a condition miss must keep failing loudly (no silent fallback),
 * and only PRIMARY KEY / UNIQUE violations may convert to `conflict`.
 */

const EVENTS_TABLE = "Events";
const TEAMS_TABLE = "Teams";
const AT = "2026-07-08T12:00:00.000Z";

function sampleEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "01EVENTAAAAAAAAAAAAAAAAAAA",
    tenantId: "tenant-a",
    name: "Spring Cup",
    status: "READY",
    problems: [],
    teamCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: 4102444800,
    ...overrides,
  };
}

function ddbThrowing(err: unknown): DynamoDBDocumentClient {
  return {
    send: async () => {
      throw err;
    },
  } as unknown as DynamoDBDocumentClient;
}

function namedError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name }, extra);
}

describe("DynamoDbEventsRepository error paths", () => {
  it("should rethrow a non-ConditionalCheck error from a conditional update", async () => {
    const repo = new DynamoDbEventsRepository(
      ddbThrowing(namedError("ProvisionedThroughputExceededException")),
      EVENTS_TABLE,
      TEAMS_TABLE,
    );
    await expect(repo.endEvent("tenant-a", "e1", AT)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
    await expect(repo.markTeardown("tenant-a", "e1", AT)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
    await expect(repo.updateSchedule("tenant-a", "e1", { endsAt: AT }, AT)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
    await expect(repo.clearProgressionGate("tenant-a", "e1", AT)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });

  it("should fold a degenerate ALL_NEW response without Attributes to not_found", async () => {
    const repo = new DynamoDbEventsRepository(
      { send: async () => ({}) } as unknown as DynamoDBDocumentClient,
      EVENTS_TABLE,
      TEAMS_TABLE,
    );
    await expect(repo.endEvent("tenant-a", "e1", AT)).resolves.toEqual({ outcome: "not_found" });
    await expect(repo.lockScoring("tenant-a", "e1", "sub", AT)).resolves.toEqual({
      outcome: "not_found",
    });
  });

  it("should fail loudly when createEventWithTeams runs on an events-only wiring", async () => {
    const repo = new DynamoDbEventsRepository(
      { send: async () => ({}) } as unknown as DynamoDBDocumentClient,
      EVENTS_TABLE,
    );
    await expect(repo.createEventWithTeams(sampleEvent(), [])).rejects.toThrow(
      /requires a teamsTableName/,
    );
  });

  it("should rethrow a TransactionCanceledException without a ConditionalCheckFailed reason", async () => {
    const repo = new DynamoDbEventsRepository(
      ddbThrowing(
        namedError("TransactionCanceledException", {
          CancellationReasons: [{ Code: "TransactionConflict" }],
        }),
      ),
      EVENTS_TABLE,
      TEAMS_TABLE,
    );
    await expect(repo.createEventWithTeams(sampleEvent(), [])).rejects.toThrow(
      "TransactionCanceledException",
    );
  });

  it("should rethrow a non-transactional error from createEventWithTeams", async () => {
    const repo = new DynamoDbEventsRepository(
      ddbThrowing(namedError("InternalServerError")),
      EVENTS_TABLE,
      TEAMS_TABLE,
    );
    await expect(repo.createEventWithTeams(sampleEvent(), [])).rejects.toThrow(
      "InternalServerError",
    );
  });
});

describe("SqlEventsRepository error paths", () => {
  function sqlWithBatchError(err: unknown): SqlExecutor {
    const base = makeSqliteExecutor();
    return {
      ...base,
      batch: () => {
        throw err;
      },
    };
  }

  it("should convert a libsql PRIMARY KEY / UNIQUE violation (extendedCode) to conflict", async () => {
    // @libsql/client は code="SQLITE_CONSTRAINT" + extendedCode に詳細を載せる。
    const pk = new SqlEventsRepository(
      sqlWithBatchError(
        Object.assign(new Error("SQLite error: PRIMARY KEY constraint violated"), {
          code: "SQLITE_CONSTRAINT",
          extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
        }),
      ),
    );
    await expect(pk.createEventWithTeams(sampleEvent(), [])).resolves.toEqual({
      outcome: "conflict",
    });

    const unique = new SqlEventsRepository(
      sqlWithBatchError(
        Object.assign(new Error("SQLite error: unique index violated"), {
          code: "SQLITE_CONSTRAINT",
          extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
        }),
      ),
    );
    await expect(unique.createEventWithTeams(sampleEvent(), [])).resolves.toEqual({
      outcome: "conflict",
    });
  });

  it("should rethrow non-uniqueness constraint classes (NOT NULL) loudly", async () => {
    const repo = new SqlEventsRepository(
      sqlWithBatchError(
        Object.assign(new Error("SQLite error: NOT NULL constraint failed: events.tenant_id"), {
          code: "SQLITE_CONSTRAINT",
          extendedCode: "SQLITE_CONSTRAINT_NOTNULL",
        }),
      ),
    );
    await expect(repo.createEventWithTeams(sampleEvent(), [])).rejects.toThrow(
      /NOT NULL constraint failed/,
    );
  });

  it("should rethrow a non-Error batch failure untouched", async () => {
    const repo = new SqlEventsRepository(sqlWithBatchError("driver exploded"));
    await expect(repo.createEventWithTeams(sampleEvent(), [])).rejects.toBe("driver exploded");
  });
});
