import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkTeardownEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-delete";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend, eventsSend };
}

const sampleEvent = (over: Record<string, unknown> = {}) => ({
  eventId: "EV1",
  tenantId: "tenant-acme",
  name: "Spring 2026",
  status: "DRAFT",
  ...over,
});

const dep = (over: Record<string, unknown> = {}) => ({
  jobId: "01HJOBONE",
  eventId: "EV1",
  tenantId: "tenant-acme",
  problemId: "p",
  awsAccountId: "999999999999",
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/development/tenants/tenant-acme/external-id",
  region: "ap-northeast-1",
  namePrefix: "tc-p-team-1",
  status: "COMPLETE",
  ...over,
});

describe("bulkTeardownEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case: should Get(Event) confirm → filter deployment by eventId, parallel-update to DELETING, and publish DeployDeleteRequested", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({
      // Query(Deployments) — server-side FilterExpression が EV1 のみ返す
      // (OTHER event は DDB が事前に除外、test mock は事後の状態を再現)
      Items: [
        dep({ jobId: "01A", namePrefix: "tc-p-t1" }),
        dep({ jobId: "01B", namePrefix: "tc-p-t2", eventId: "EV1" }),
      ],
    });
    ddbSend.mockResolvedValue({}); // 並列 Update * 2
    eventsSend.mockResolvedValue({}); // PutEvents 1 chunk

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 2, skipped: 0, failed: 0 },
    });

    // Query が FilterExpression で eventId 一致を要求し、cross-event 漏洩を防ぐ
    const queryCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queryCmds[0]?.input.FilterExpression).toBe("eventId = :ev");
    expect(queryCmds[0]?.input.ExpressionAttributeValues?.[":ev"]).toBe("EV1");

    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    // 2 deployment updates (DELETING) + 1 Event status update (TEARDOWN, #557)
    expect(updateCmds).toHaveLength(3);
    const depUpdates = updateCmds.filter(
      (c) => c.input.ExpressionAttributeValues?.[":deleting"] === "DELETING",
    );
    expect(depUpdates).toHaveLength(2);
    for (const cmd of depUpdates) {
      expect(cmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    }
    // #557: Event status TEARDOWN への遷移を pin
    const eventStatusUpdate = updateCmds.find(
      (c) => c.input.ExpressionAttributeValues?.[":teardown"] === "TEARDOWN",
    );
    expect(eventStatusUpdate).toBeDefined();
    expect(eventStatusUpdate?.input.ConditionExpression).toContain("#status <> :archived");
    expect(eventStatusUpdate?.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd.input.Entries).toHaveLength(2);
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
  });

  it("should return not_found without calling Deployments query when the event is absent", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return not_found on tenantId mismatch (cross-tenant leak guard)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ tenantId: "tenant-other" }) });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should skip and not publish for rows already DELETING / DELETED", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({ jobId: "01A", status: "DELETING" }),
        dep({ jobId: "01B", status: "DELETED" }),
        dep({ jobId: "01C", status: "COMPLETE" }),
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.result.enqueued).toBe(1);
      expect(out.result.skipped).toBe(2);
    }
  });

  it("should include AssumeRole metadata in DeployDeleteRequested detail (#758)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({
          jobId: "01A",
          competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
          externalIdParameterName: "/development/tenants/tenant-acme/external-id",
        }),
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(String(putCmd.input.Entries?.[0]?.Detail)) as {
      competitorRoleArn?: string;
      externalIdParameterName?: string;
    };
    expect(detail.competitorRoleArn).toBe(
      "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(detail.externalIdParameterName).toBe("/development/tenants/tenant-acme/external-id");
  });

  it("should return enqueued=0 when the event exists but has 0 deployments (not yet deployed)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should skip and not propagate exceptions on ConditionalCheckFailed (concurrent update)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // Event status update (= 後続の 4th call) は通常 success を返す fallback。
    // #557 で 1 deployment + Event status の 2 件目 UpdateCommand が増えたため。
    ddbSend.mockResolvedValue({});
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [dep()] });
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        const err: Error & { name?: string } = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 1, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("#1797: should compensate (DELETING -> FAILED) and count rows whose PutEvents entry failed (FailedEntryCount > 0)", async () => {
    // EventBridge PutEvents は HTTP 200 でも個別 entry が落ちる (FailedEntryCount > 0)。 旧コードは
    // これを無視し teardown event を silent drop → stack orphan。 publish できなかった行は
    // DELETING のままだと再 DELETE でも skip され永久に消えない。 FAILED に巻き戻して retry 可能化する。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A" }), dep({ jobId: "01B" })] }); // Query
    ddbSend.mockResolvedValue({}); // DELETING transitions + Event TEARDOWN + compensation
    // 200 だが 2 件目 (01B) の entry が失敗。 response.Entries は入力 Entries と同順。
    eventsSend.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ EventId: "ok" }, { ErrorCode: "ThrottlingException", ErrorMessage: "rate" }],
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 1 },
    });

    const compensations = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED");
    expect(compensations).toHaveLength(1);
    expect(compensations[0]?.input.Key?.PK).toBe("DEPLOYMENT#01B");
    // DELETING の行だけを FAILED に倒す (= 他経路で既に終端化した行は踏まない)。
    expect(compensations[0]?.input.ConditionExpression).toContain(":deleting");
  });

  it("#1797: should compensate every row in a chunk that PutEvents rejected entirely", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A" }), dep({ jobId: "01B" })] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockRejectedValue(new Error("EventBridge unavailable")); // chunk 全体が reject

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 2 },
    });

    const compensated = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED")
      .map((c) => c.input.Key?.PK)
      .sort();
    expect(compensated).toEqual(["DEPLOYMENT#01A", "DEPLOYMENT#01B"]);
  });

  it("should still complete deployment delete without propagating exceptions even if Event status update hits CCF (e.g. ARCHIVED) (#557)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ status: "ARCHIVED" }) });
    // GetCommand 後の "ARCHIVED" 判定は handler では行わないので Query へ進む。
    ddbSend.mockResolvedValueOnce({ Items: [dep()] });
    // deployment update success
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValue({});
    // Event status update で CCF を投げる (= ARCHIVED から踏み越えられない条件)
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (
        cmd instanceof UpdateCommand &&
        cmd.input.ExpressionAttributeValues?.[":teardown"] === "TEARDOWN"
      ) {
        const err: Error & { name?: string } = new Error("archived");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // handler は正常に完了 (= deployment は DELETING に倒した)
    expect(out.kind).toBe("ok");
  });

  it("#1810: should tear down a FAILED deployment whose stackId is empty (fallback to namePrefix)", async () => {
    // 失敗 deployment は stack ARN 記録前に終わると stackId="" (空文字、null ではない)。
    // 旧コードは `stackId ?? namePrefix` で空文字を fallback できず stackName="" → skip し、
    // 失敗 stack を orphan 化していた。namePrefix で delete-stack できるよう enqueue されること。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({
      Items: [dep({ jobId: "01FAIL", status: "FAILED", stackId: "", namePrefix: "tc-p-team-9" })],
    });
    ddbSend.mockResolvedValue({}); // transition + Event status
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(String(putCmd.input.Entries?.[0]?.Detail)) as { stackName?: string };
    expect(detail.stackName).toBe("tc-p-team-9");
  });

  it("Deployments query should hit GSI1 (TENANT) and filter eventId in-memory", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 1 件目: Get(Event)
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    // 2 件目: Query(Deployments GSI1)
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(eventsSend).not.toHaveBeenCalled();
  });
});
