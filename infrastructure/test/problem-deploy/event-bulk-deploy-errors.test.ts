import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

describe("bulkDeployEvent — error & guard paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return not_found without DDB write / publish when the event is absent", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    // #2436: loadBulkDeployTargets が Event Get と Teams 一覧を Promise.all で並列発火するため、
    // event 不在でも seam の listTeamsByEvent は query 結果を読む。 concurrent の Teams 応答を渡す。
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return not_found without writing on tenantId mismatch (cross-tenant leak guard)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ tenantId: "tenant-other" }) });
    // #2436: getEvent が tenant 不一致を undefined に畳むが、 並列の listTeamsByEvent は query 結果を
    // 読むため concurrent の Teams 応答を渡す (= cross-tenant でも早期 not_found、 result は破棄)。
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return enqueued=0 without writing when teams or problems is empty", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ problems: [] }) });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(3) });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 0 } });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should skip when neither team.awsAccountId nor problem.defaultAwsAccountId is present (#528)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // problem.defaultAwsAccountId を外した event
    ddbSend.mockResolvedValueOnce({
      Item: sampleEvent({
        problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
      }),
    });
    // team.awsAccountId も無い旧 team
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          eventId: "EV1",
          teamId: "T1",
          tenantId: "tenant-acme",
          internalSlug: "team-1",
          teamLoginKey: "key-1",
        },
      ],
    });
    // #555: 既存 deployments query (空)
    ddbSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 1 team × 1 problem = 1、awsAccountId 無いので全 skip
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 1 } });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should mark the affected deployments as FAILED and keep them retryable on PutEvents partial failure", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{}, { ErrorCode: "InternalFailure", ErrorMessage: "event bus down" }],
    });

    await expect(bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      /EventBridge PutEvents failed/,
    );

    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const failedJobId = transactCmd?.input.TransactItems?.[1]?.Put?.Item?.jobId;
    const failureUpdates = ddbSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c): c is UpdateCommand =>
          c instanceof UpdateCommand &&
          c.input.TableName === "TestDeployments" &&
          c.input.ExpressionAttributeValues?.[":failed"] === "FAILED",
      );
    expect(failureUpdates).toHaveLength(1);
    expect(failureUpdates[0]?.input.Key).toEqual({ PK: `DEPLOYMENT#${failedJobId}`, SK: "META" });
    expect(failureUpdates[0]?.input.ConditionExpression).toContain("#s = :pending");
    expect(failureUpdates[0]?.input.ExpressionAttributeValues?.[":reason"]).toContain(
      "InternalFailure: event bus down",
    );
  });

  it("should mark the deployments in the chunk as FAILED and keep them retryable on PutEvents timeout/reject", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockRejectedValueOnce(new Error("EventBridge timeout"));

    await expect(bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      /EventBridge PutEvents failed/,
    );

    const failureUpdates = ddbSend.mock.calls
      .map((c) => c[0])
      .filter(
        (c): c is UpdateCommand =>
          c instanceof UpdateCommand &&
          c.input.TableName === "TestDeployments" &&
          c.input.ExpressionAttributeValues?.[":failed"] === "FAILED",
      );
    expect(failureUpdates).toHaveLength(2);
    expect(
      failureUpdates.every((u) =>
        String(u.input.ExpressionAttributeValues?.[":reason"] ?? "").includes(
          "EventBridge timeout",
        ),
      ),
    ).toBe(true);
  });
});
