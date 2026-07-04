import { PutObjectCommand } from "@aws-sdk/client-s3";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { archiveRuntimeScoreEvents } from "../../lib/always-on-runtime/handlers/runtime-score-archive.js";

const CONFIG = {
  deploymentsTableName: "Deployments",
  archiveBucketName: "archive-bucket",
} as const;
const NOW = new Date("2026-07-04T12:34:56.789Z");

function scoreEvent(overrides: Record<string, unknown> = {}) {
  return {
    PK: "DEPLOYMENT#job-1",
    SK: "EVENT#2026-07-04T12:00:00.000Z#01",
    jobId: "job-1",
    problemId: "battle-1",
    teamId: "team-1",
    eventId: "evt-1",
    source: "uptime",
    points: 10,
    result: "ok",
    occurredAt: "2026-07-04T12:00:00.000Z",
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

function dependencies(pages: readonly Record<string, unknown>[]) {
  const remaining = [...pages];
  return {
    ddb: {
      send: vi.fn(async (command: unknown) => {
        expect(command).toBeInstanceOf(ScanCommand);
        return remaining.shift() ?? { Items: [] };
      }),
    },
    s3: {
      send: vi.fn(async (command: unknown) => {
        expect(command).toBeInstanceOf(PutObjectCommand);
        return {};
      }),
    },
    now: () => NOW,
  };
}

describe("archiveRuntimeScoreEvents", () => {
  it("should write bounded JSONL parts then publish the latest manifest", async () => {
    const deps = dependencies([
      {
        Items: [scoreEvent(), scoreEvent({ SK: "META" }), scoreEvent({ eventId: "other" })],
        LastEvaluatedKey: { PK: "next" },
      },
      {
        Items: [
          scoreEvent({
            PK: "DEPLOYMENT#job-2",
            SK: "EVENT#2026-07-04T12:01:00.000Z#02",
            jobId: "job-2",
          }),
        ],
      },
    ]);

    const result = await archiveRuntimeScoreEvents({ eventId: "evt-1" }, CONFIG, deps);

    expect(deps.ddb.send).toHaveBeenCalledTimes(2);
    expect(deps.s3.send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      eventId: "evt-1",
      eventCount: 2,
      manifestKey: "events/evt-1/score-events/latest.json",
      partKeys: [
        "events/evt-1/score-events/runs/20260704T123456789Z/part-000001.jsonl",
        "events/evt-1/score-events/runs/20260704T123456789Z/part-000002.jsonl",
      ],
    });
    const commands = deps.s3.send.mock.calls.map(([command]) => command as PutObjectCommand);
    expect(commands[0].input.ContentType).toBe("application/x-ndjson");
    expect(String(commands[0].input.Body).trim().split("\n")).toHaveLength(1);
    expect(commands[2].input.Key).toBe("events/evt-1/score-events/latest.json");
    expect(JSON.parse(String(commands[2].input.Body))).toMatchObject({
      formatVersion: 1,
      eventCount: 2,
      partKeys: result.partKeys,
    });
  });

  it("should write an empty manifest when no score events exist", async () => {
    const deps = dependencies([{ Items: [] }]);
    const result = await archiveRuntimeScoreEvents({ eventId: "evt-1" }, CONFIG, deps);
    expect(result.eventCount).toBe(0);
    expect(result.partKeys).toEqual([]);
    expect(deps.s3.send).toHaveBeenCalledTimes(1);
  });

  it("should reject a missing event scope before reading DynamoDB", async () => {
    const deps = dependencies([]);
    await expect(archiveRuntimeScoreEvents({}, CONFIG, deps)).rejects.toThrow(
      /eventId is required/,
    );
    expect(deps.ddb.send).not.toHaveBeenCalled();
  });
});
