import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import {
  handleUsageMeteringEvent,
  listUsageFacts,
  recordUsageFact,
} from "../../lib/problem-deploy/handlers/usage-metering-handler/repository";

function ddb(send: ReturnType<typeof vi.fn>) {
  return { send } as unknown as Parameters<typeof recordUsageFact>[0]["ddb"];
}

describe("usage metering facts", () => {
  it("should write a deploy-completed usage fact idempotently", async () => {
    const send = vi.fn().mockResolvedValue({});

    const out = await handleUsageMeteringEvent(
      { ddb: ddb(send), tableName: "UsageFacts" },
      {
        "detail-type": "DeployCompleted",
        time: "2026-06-15T01:02:03.000Z",
        detail: {
          tenantId: "tenant-a",
          jobId: "01J00000000000000000000000",
        },
      },
    );

    expect(out).toEqual({ recorded: true, statusCode: StatusCodes.OK });
    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      PK: "TENANT#tenant-a",
      SK: "EVENT#deploy:01J00000000000000000000000",
      tenantId: "tenant-a",
      detailType: "DeployCompleted",
    });
    expect(command.input.TransactItems?.[1]?.Update).toMatchObject({
      TableName: "UsageFacts",
      Key: { PK: "TENANT#tenant-a", SK: "DAY#2026-06-15" },
    });
    expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":deployCompletedCount": 1,
      ":usageEventCount": 1,
    });
  });

  it("should count scoring ticks and score events from ScoreUpdated input", async () => {
    const send = vi.fn().mockResolvedValue({});

    await handleUsageMeteringEvent(
      { ddb: ddb(send), tableName: "UsageFacts" },
      {
        "detail-type": "ScoreUpdated",
        time: "2026-06-15T01:02:03.000Z",
        detail: {
          tenantId: "tenant-a",
          tickId: "tick-123",
          scoreEventCount: 3,
        },
      },
    );

    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":scoringTickCount": 1,
      ":scoreEventCount": 3,
      ":usageEventCount": 1,
    });
  });

  it("should treat duplicate usage events as idempotent no-ops", async () => {
    const err = new Error("cancelled");
    err.name = "TransactionCanceledException";
    const send = vi.fn().mockRejectedValue(err);

    await expect(
      recordUsageFact(
        { ddb: ddb(send), tableName: "UsageFacts" },
        {
          tenantId: "tenant-a",
          day: "2026-06-15",
          detailType: "DeployCompleted",
          idempotencyKey: "deploy:j1",
          counters: { deployCompletedCount: 1 },
          occurredAt: "2026-06-15T00:00:00.000Z",
        },
      ),
    ).resolves.toEqual({ recorded: false });
  });

  it("should always count the metering event even when optional counters are zero", async () => {
    const send = vi.fn().mockResolvedValue({});

    await recordUsageFact(
      { ddb: ddb(send), tableName: "UsageFacts" },
      {
        tenantId: "tenant-a",
        day: "2026-06-15",
        detailType: "ScoreUpdated",
        idempotencyKey: "score:empty-tick",
        counters: { scoreEventCount: 0, usageEventCount: 0 },
        occurredAt: "2026-06-15T00:00:00.000Z",
      },
    );

    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":usageEventCount": 1,
    });
  });

  it("should query daily usage facts per tenant and aggregate totals", async () => {
    const send = vi.fn().mockImplementation(async (cmd: QueryCommand) => {
      expect(cmd).toBeInstanceOf(QueryCommand);
      if (cmd.input.ExpressionAttributeValues?.[":pk"] === "TENANT#tenant-a") {
        return {
          Items: [
            {
              tenantId: "tenant-a",
              day: "2026-06-14",
              deployCompletedCount: 1,
              scoringTickCount: 2,
              scoreEventCount: 4,
              tenantEventCount: 1,
              usageEventCount: 3,
            },
            {
              tenantId: "tenant-a",
              day: "2026-06-15",
              deployCompletedCount: 2,
              scoringTickCount: 1,
              scoreEventCount: 1,
              tenantEventCount: 0,
              usageEventCount: 2,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await listUsageFacts(
      { ddb: ddb(send), tableName: "UsageFacts" },
      { tenantIds: ["tenant-a", "tenant-b"], from: "2026-06-14", to: "2026-06-15" },
    );

    expect(result.items[0]).toMatchObject({
      tenantId: "tenant-a",
      totals: {
        deployCompletedCount: 3,
        scoringTickCount: 3,
        scoreEventCount: 5,
        tenantEventCount: 1,
        usageEventCount: 5,
      },
    });
    expect(result.items[0]?.days).toHaveLength(2);
    expect(result.items[1]).toMatchObject({
      tenantId: "tenant-b",
      totals: {
        deployCompletedCount: 0,
        scoringTickCount: 0,
        scoreEventCount: 0,
        tenantEventCount: 0,
        usageEventCount: 0,
      },
      days: [],
    });
  });
});
