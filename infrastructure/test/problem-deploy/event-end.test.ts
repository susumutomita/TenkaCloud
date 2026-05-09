import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { endEvent } from "../../lib/problem-deploy/handlers/event-handler/end-event";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: vi.fn() } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

function conditionalFailure(): Error {
  const err = new Error("conditional failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

describe("endEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: Event 行を ENDED に更新し全 deployment 行に eventEndsAt を伝播するべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: Event UpdateCommand returns Attributes (= status=READY が条件を満たした)
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        status: "ENDED",
        endsAt: NOW_ISO,
      },
    });
    // 2nd: Deployments QueryCommand
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#J1", eventId: "EV1" },
        { PK: "DEPLOYMENT#J2", eventId: "EV1" },
        { PK: "DEPLOYMENT#J3", eventId: "EV1" },
      ],
    });
    // 3rd-5th: Deployments UpdateCommand × 3
    ddbSend.mockResolvedValue({});

    const out = await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", endsAt: NOW_ISO, updatedDeployments: 3 });

    // Event 更新の ConditionExpression が tenantId 一致 + status=READY を要求する
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(eventUpd).toBeInstanceOf(UpdateCommand);
    expect(eventUpd.input.ConditionExpression).toBe("tenantId = :tenantId AND #s = :ready");
    expect(eventUpd.input.ExpressionAttributeNames?.["#s"]).toBe("status");
    expect(eventUpd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    expect(eventUpd.input.ExpressionAttributeValues?.[":ready"]).toBe("READY");
    expect(eventUpd.input.ExpressionAttributeValues?.[":ended"]).toBe("ENDED");
    expect(eventUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);

    // Deployments query は GSI1 = TENANT# + FilterExpression eventId 一致 (cross-event 漏洩防止)
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(queryCmd.input.FilterExpression).toBe("eventId = :ev");
    expect(queryCmd.input.ExpressionAttributeValues?.[":ev"]).toBe("EV1");

    // Deployment update は EV1 行 3 件のみ走り、eventEndsAt = NOW_ISO を SET
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(3);
    const updatedPks = updCmds.map((c) => (c.input.Key as { PK: string }).PK).sort();
    expect(updatedPks).toEqual(["DEPLOYMENT#J1", "DEPLOYMENT#J2", "DEPLOYMENT#J3"]);
    for (const cmd of updCmds) {
      expect(cmd.input.UpdateExpression).toContain("eventEndsAt = :e");
      expect(cmd.input.ExpressionAttributeValues?.[":e"]).toBe(NOW_ISO);
    }
  });

  it("status != READY (= DRAFT 等) なら not_endable で 409 相当を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: Event Update が ConditionalCheckFailed
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    // 2nd: probe Get で行は存在 + tenantId 一致 + status=DRAFT
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-acme", status: "DRAFT" },
    });

    const out = await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_endable", status: "DRAFT" });

    // probe Get は GetCommand
    expect(ddbSend.mock.calls[1]?.[0]).toBeInstanceOf(GetCommand);
    // Deployments query / update は 1 度も走らない
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("Event 行不在 (probe で Item 無し) は not_found を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("tenant 不一致 (probe で別 tenant) は not_found を返すべき (cross-tenant 漏洩防止)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-other", status: "READY" },
    });

    const out = await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    // 他 tenant の status を露出しないため not_endable ではなく not_found
  });

  it("対象 deployment が 0 件でも ok を返し updatedDeployments=0", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", status: "ENDED", endsAt: NOW_ISO },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", endsAt: NOW_ISO, updatedDeployments: 0 });
    // Deployment Update は走らない (Promise.all([]))
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(0);
  });

  it("Event 更新 + 全 deployment update の updatedAt は同じ now 値を使うべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", status: "ENDED", endsAt: NOW_ISO },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    await endEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    const deployUpd = ddbSend.mock.calls[2]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
    expect(deployUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
  });

  it("ConditionalCheckFailedException 以外の DDB エラーはそのまま throw する", async () => {
    const { shared, ddbSend } = buildShared();
    const transientErr = new Error("ProvisionedThroughputExceededException");
    transientErr.name = "ProvisionedThroughputExceededException";
    ddbSend.mockRejectedValueOnce(transientErr);

    await expect(endEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});
