import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { describe, expect, it, vi } from "vitest";
import {
  PUT_EVENTS_BATCH_SIZE,
  putEventsBatched,
} from "../../lib/problem-deploy/handlers/shared/events";

function fakeClient(send: (cmd: unknown) => Promise<unknown>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

function itemsOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    item: `id-${i}`,
    entry: { Detail: JSON.stringify({ i }) },
  }));
}

describe("putEventsBatched (issue #2210: shared PutEvents batch helper)", () => {
  it("should report every item as success when FailedEntryCount is 0", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [{}, {}] });
    const results = await putEventsBatched(fakeClient(send), itemsOf(2));
    expect(results).toEqual([
      { item: "id-0", success: true },
      { item: "id-1", success: true },
    ]);
  });

  it("should propagate the ErrorCode/ErrorMessage of the index-aligned failed entry", async () => {
    const send = vi.fn().mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{}, { ErrorCode: "InternalFailure", ErrorMessage: "transient" }],
    });
    const results = await putEventsBatched(fakeClient(send), itemsOf(2));
    expect(results).toEqual([
      { item: "id-0", success: true },
      {
        item: "id-1",
        success: false,
        errorCode: "InternalFailure",
        errorMessage: "transient",
      },
    ]);
  });

  it("should default errorMessage to 'unknown error' when the entry omits it", async () => {
    const send = vi.fn().mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "ThrottlingException" }],
    });
    const results = await putEventsBatched(fakeClient(send), itemsOf(1));
    expect(results[0]).toMatchObject({
      success: false,
      errorCode: "ThrottlingException",
      errorMessage: "unknown error",
    });
  });

  it("should split more than PUT_EVENTS_BATCH_SIZE items into multiple PutEvents calls", async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [] });
    const total = PUT_EVENTS_BATCH_SIZE + 3;
    const results = await putEventsBatched(fakeClient(send), itemsOf(total));
    expect(send).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(total);
    expect(results.every((r) => r.success)).toBe(true);
    // chunk sizes: PUT_EVENTS_BATCH_SIZE then the remainder.
    const firstCall = send.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("Expected the first PutEvents call");
    const firstCallEntries = (firstCall[0] as { input: { Entries: unknown[] } }).input.Entries;
    expect(firstCallEntries).toHaveLength(PUT_EVENTS_BATCH_SIZE);
  });

  it("should mark every item in a chunk as failed when the whole request rejects", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network down"));
    const results = await putEventsBatched(fakeClient(send), itemsOf(2));
    expect(results).toEqual([
      { item: "id-0", success: false, errorMessage: "network down" },
      { item: "id-1", success: false, errorMessage: "network down" },
    ]);
  });

  it("should return an empty array for an empty input without calling send", async () => {
    const send = vi.fn();
    const results = await putEventsBatched(fakeClient(send), []);
    expect(results).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
