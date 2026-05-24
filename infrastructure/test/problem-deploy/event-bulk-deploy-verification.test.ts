import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

describe("bulkDeployEvent — verification, ExternalId & distributed map path", () => {
  beforeEach(() => vi.clearAllMocks());

  // Phase 2.2 (Issue #459) Worker cross-account 化:
  // CompetitorAccounts table で verified=true 行が無い awsAccountId は reject されるべき
  it("should drop verified=false / unregistered awsAccountId from the plan and count it as unverified", async () => {
    const { shared, ddbSend, eventsSend, setVerifiedAccounts } = buildShared();
    // T1 (111111111111) のみ verified、T2 (222222222222) は未登録
    setVerifiedAccounts(new Set(["111111111111"]));
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // 2 problems
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) }); // T1, T2
    ddbSend.mockResolvedValueOnce({ Items: [] }); // 既存 deployments 空
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // T1×2 problems = 2 enqueue、T2×2 problems = 2 reject、unverified set は {222...}
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(2);
    expect(out.result.unverified).toBe(1);
    expect(out.result.unverifiedAccounts).toEqual(["222222222222"]);

    // sampleEvent の problem.defaultAwsAccountId (= 999999999999) もあるが、team.awsAccountId
    // が両 team とも埋まっているので fallback は使われない → 999... は plan に来ない。
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is TransactWriteCommand => c instanceof TransactWriteCommand);
    const items = transactCmd?.input.TransactItems ?? [];
    for (const it of items) {
      expect(it.Put?.Item?.awsAccountId).toBe("111111111111");
      expect(it.Put?.Item?.competitorRoleArn).toBe(
        "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
      );
    }
  });

  // Phase 2.2: 全 team が unverified なら write も publish もしない (fail-closed)
  it("should return enqueued=0 without write / publish when all teams are unverified", async () => {
    const { shared, ddbSend, eventsSend, setVerifiedAccounts } = buildShared();
    setVerifiedAccounts(new Set()); // verified なし
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.result.enqueued).toBe(0);
    expect(out.result.unverified).toBe(2);
    expect(out.result.unverifiedAccounts).toEqual(["111111111111", "222222222222"]);
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof TransactWriteCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  // Phase 2.2: DeployCreateRequested の detail に competitorRoleArn / externalIdParameterName を埋めるべき
  it("should include competitorRoleArn and externalIdParameterName for AssumeRole in DeployCreateRequested detail", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) }); // T1 only
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const putCmd = eventsSend.mock.calls
      .map((c) => c[0])
      .find((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    const detailRaw = putCmd?.input.Entries?.[0]?.Detail;
    expect(detailRaw).toBeDefined();
    const detail = JSON.parse(String(detailRaw ?? "{}"));
    // T1 awsAccountId は 111111111111、SSM path は `/development/tenants/tenant-acme/external-id`
    expect(detail.competitorRoleArn).toBe(
      "arn:aws:iam::111111111111:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(detail.externalIdParameterName).toBe("/development/tenants/tenant-acme/external-id");
  });

  // Issue #910 (#895 Phase 2.C.2.b): Distributed Map 経路の feature-flag 切替 test。
  // useBulkDistributedMap=true + bulkDeployPayloadBucket 設定済のとき、 fan-out (= N×M
  // 個の DeployCreateRequested publish) ではなく S3 PutObject + 1 BulkDeployCreateRequested
  // publish に切替わるべき。
  it("should switch to S3 PutObject + 1 BulkDeployCreateRequested when useBulkDistributedMap=true", async () => {
    const s3Send = vi.fn().mockResolvedValue({});
    const { shared, ddbSend, eventsSend } = buildShared({
      s3: { send: s3Send } as unknown as EventSharedResources["s3"],
      bulkDeployPayloadBucket: "test-bulk-bucket",
      useBulkDistributedMap: true,
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    // S3 PutObject が exactly 1 回。 batches/<batchId>/deployments.json に書く。
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3Calls = s3Send.mock.calls
      .map((c) => c[0])
      .filter((c): c is InstanceType<typeof PutObjectCommand> => c instanceof PutObjectCommand);
    expect(s3Calls).toHaveLength(1);
    expect(s3Calls[0]?.input.Bucket).toBe("test-bulk-bucket");
    expect(s3Calls[0]?.input.Key).toMatch(/^batches\/[0-9A-Z]+\/deployments\.json$/);
    expect(s3Calls[0]?.input.ContentType).toBe("application/json");
    // S3 body は deployment 配列の JSON
    const body = JSON.parse(String(s3Calls[0]?.input.Body ?? "[]"));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].jobId).toBeDefined();

    // EventBridge は BulkDeployCreateRequested を **1 回だけ** publish (= fan-out 撤廃)。
    const eventCalls = eventsSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.input.Entries?.[0]?.DetailType).toBe("BulkDeployCreateRequested");
    const bulkDetail = JSON.parse(String(eventCalls[0]?.input.Entries?.[0]?.Detail ?? "{}"));
    expect(bulkDetail.s3Bucket).toBe("test-bulk-bucket");
    expect(bulkDetail.s3Key).toMatch(/^batches\/[0-9A-Z]+\/deployments\.json$/);
    expect(bulkDetail.tenantId).toBe("tenant-acme");
    expect(bulkDetail.itemCount).toBe(body.length);
  });

  it("should fail all plans to FAILED when S3 PutObject fails, even with useBulkDistributedMap=true", async () => {
    const s3Send = vi.fn().mockRejectedValue(new Error("S3 throttle"));
    const { shared, ddbSend, eventsSend } = buildShared({
      s3: { send: s3Send } as unknown as EventSharedResources["s3"],
      bulkDeployPayloadBucket: "test-bulk-bucket",
      useBulkDistributedMap: true,
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});

    await expect(bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      /S3 PutObject failed|PutEvents failed/,
    );
    // EventBridge は呼ばれない (= S3 失敗で早期中止)
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should keep the old fan-out path when useBulkDistributedMap=false (rollback safety)", async () => {
    const s3Send = vi.fn().mockResolvedValue({});
    const { shared, ddbSend, eventsSend } = buildShared({
      s3: { send: s3Send } as unknown as EventSharedResources["s3"],
      bulkDeployPayloadBucket: "test-bulk-bucket",
      useBulkDistributedMap: false, // 明示的に旧 path を使う
    });
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    // S3 は触らない (= 旧 path)
    expect(s3Send).not.toHaveBeenCalled();
    // EventBridge は fan-out で複数 DeployCreateRequested を publish (= problems 2 × team 1 = 2 events)
    const eventCalls = eventsSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutEventsCommand => c instanceof PutEventsCommand);
    expect(eventCalls.length).toBeGreaterThan(0);
    // 旧 path は DeployCreateRequested を publish (= BulkDeployCreateRequested ではない)
    expect(eventCalls[0]?.input.Entries?.[0]?.DetailType).toBe("DeployCreateRequested");
  });
});
