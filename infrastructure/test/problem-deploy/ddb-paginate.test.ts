import { type QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  forEachScanPage,
  queryAllItems,
  queryAllItemsBounded,
  scanAllItems,
} from "../../lib/problem-deploy/handlers/shared/ddb-paginate";

const BASE = {
  TableName: "T",
  IndexName: "GSI1",
  KeyConditionExpression: "GSI1PK = :pk",
  FilterExpression: "eventId = :ev",
  ExpressionAttributeValues: { ":pk": "TENANT#t", ":ev": "evt-1" },
};

const SCAN_BASE = {
  TableName: "T",
  FilterExpression: "#status = :complete",
  ExpressionAttributeNames: { "#status": "status" },
  ExpressionAttributeValues: { ":complete": "COMPLETE" },
  Limit: 200,
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

describe("scanAllItems", () => {
  it("should return the single page when there is no LastEvaluatedKey", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ jobId: "a" }] });
    const result = await scanAllItems({ send } as never, SCAN_BASE);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(result).toEqual([{ jobId: "a" }]);
    // 1 ページ目は ExclusiveStartKey を付けない。
    expect((send.mock.calls[0]?.[0] as ScanCommand).input.ExclusiveStartKey).toBeUndefined();
  });

  it("should drain every page and follow LastEvaluatedKey, concatenating in order", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }], LastEvaluatedKey: { PK: "p2" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "c" }] });
    const result = await scanAllItems({ send } as never, SCAN_BASE);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual([{ jobId: "a" }, { jobId: "b" }, { jobId: "c" }]);
    expect((send.mock.calls[1]?.[0] as ScanCommand).input.ExclusiveStartKey).toEqual({ PK: "p1" });
    expect((send.mock.calls[2]?.[0] as ScanCommand).input.ExclusiveStartKey).toEqual({ PK: "p2" });
  });

  it("should preserve the caller's scan input (filter/limit) on every page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [] });
    await scanAllItems({ send } as never, SCAN_BASE);
    for (const call of send.mock.calls) {
      const cmd = call[0] as ScanCommand;
      expect(cmd.input.FilterExpression).toBe("#status = :complete");
      expect(cmd.input.Limit).toBe(200);
    }
  });

  it("should treat a missing Items array as no items (not a crash)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await scanAllItems({ send } as never, SCAN_BASE);
    expect(result).toEqual([]);
  });
});

describe("forEachScanPage", () => {
  it("should invoke the callback once per page in order, draining LastEvaluatedKey", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }, { jobId: "c" }] });
    const pages: Record<string, unknown>[][] = [];
    await forEachScanPage({ send } as never, SCAN_BASE, async (page) => {
      pages.push(page);
    });
    expect(send).toHaveBeenCalledTimes(2);
    // 各ページの items が page 単位で (= 集約せず) callback に渡る。
    expect(pages).toEqual([[{ jobId: "a" }], [{ jobId: "b" }, { jobId: "c" }]]);
    expect((send.mock.calls[0]?.[0] as ScanCommand).input.ExclusiveStartKey).toBeUndefined();
    expect((send.mock.calls[1]?.[0] as ScanCommand).input.ExclusiveStartKey).toEqual({ PK: "p1" });
  });

  it("should pass an empty array to the callback when a page omits Items", async () => {
    const send = vi.fn().mockResolvedValue({});
    const pages: Record<string, unknown>[][] = [];
    await forEachScanPage({ send } as never, SCAN_BASE, async (page) => {
      pages.push(page);
    });
    expect(pages).toEqual([[]]);
  });
});

describe("queryAllItemsBounded", () => {
  it("should stop at maxPages even when LastEvaluatedKey still remains", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }], LastEvaluatedKey: { PK: "p2" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "c" }], LastEvaluatedKey: { PK: "p3" } });
    const result = await queryAllItemsBounded({ send } as never, BASE, 2);
    // 上限 2 ページで打ち止め (3 ページ目以降の LastEvaluatedKey は無視)。
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ jobId: "a" }, { jobId: "b" }]);
    expect((send.mock.calls[1]?.[0] as QueryCommand).input.ExclusiveStartKey).toEqual({ PK: "p1" });
  });

  it("should stop early when a page returns no LastEvaluatedKey before maxPages", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ jobId: "a" }], LastEvaluatedKey: { PK: "p1" } })
      .mockResolvedValueOnce({ Items: [{ jobId: "b" }] });
    const result = await queryAllItemsBounded({ send } as never, BASE, 5);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ jobId: "a" }, { jobId: "b" }]);
  });
});
