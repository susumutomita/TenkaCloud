import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { queryAllItems } from "../../lib/problem-deploy/handlers/shared/ddb-paginate";

const BASE = {
  TableName: "T",
  IndexName: "GSI1",
  KeyConditionExpression: "GSI1PK = :pk",
  FilterExpression: "eventId = :ev",
  ExpressionAttributeValues: { ":pk": "TENANT#t", ":ev": "evt-1" },
};

describe("queryAllItems", () => {
  it("should return the single page when there is no LastEvaluatedKey", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ jobId: "a" }] });
    const result = await queryAllItems({ send } as never, BASE);
    expect(send).toHaveBeenCalledOnce();
    expect(result).toEqual([{ jobId: "a" }]);
    // 1 ページ目は ExclusiveStartKey を付けない。
    expect((send.mock.calls[0]?.[0] as QueryCommand).input.ExclusiveStartKey).toBeUndefined();
  });

  it("should drain every page and concatenate all items in order", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }], LastEvaluatedKey: { PK: "p2" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "c" }] });
    const result = await queryAllItems({ send } as never, BASE);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual([{ jobId: "a" }, { jobId: "b" }, { jobId: "c" }]);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ PK: "p1" });
    expect((send.mock.calls[2]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ PK: "p2" });
  });

  it("should preserve the caller's query input (filter/projection) on every page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [] });
    await queryAllItems({ send } as never, BASE);
    for (const call of send.mock.calls) {
      const cmd = call[0] as QueryCommand;
      expect(cmd.input.FilterExpression).toBe("eventId = :ev");
      expect(cmd.input.KeyConditionExpression).toBe("GSI1PK = :pk");
    }
  });

  it("should treat a missing Items array as no items (not a crash)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await queryAllItems({ send } as never, BASE);
    expect(result).toEqual([]);
  });
});
