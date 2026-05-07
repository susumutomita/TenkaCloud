import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventSchedule } from "../../lib/problem-deploy/handlers/event-handler/schedule";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const STARTS_AT = "2026-05-08T10:00:00.000Z";

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

describe("setEventSchedule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: Event 行 + 紐づく全 deployment 行の eventStartsAt を更新するべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: Event UpdateCommand returns Attributes (= 行が存在 + tenantId 一致)
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        startsAt: STARTS_AT,
      },
    });
    // 2nd: Deployments QueryCommand (GSI1 = TENANT#)
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#J1", eventId: "EV1" },
        { PK: "DEPLOYMENT#J2", eventId: "EV1" },
        { PK: "DEPLOYMENT#J3", eventId: "EV-OTHER" }, // 別 event は除外
        { PK: "DEPLOYMENT#J4", eventId: "EV1" },
      ],
    });
    // 3rd-5th: Deployments UpdateCommand × 3 (J1, J2, J4 — EV-OTHER は skip)
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "ok", startsAt: STARTS_AT, updatedDeployments: 3 });

    // Event 更新の ConditionExpression が tenantId 一致を要求する
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(eventUpd).toBeInstanceOf(UpdateCommand);
    expect(eventUpd.input.ConditionExpression).toBe("tenantId = :tenantId");
    expect(eventUpd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    expect(eventUpd.input.ExpressionAttributeValues?.[":startsAt"]).toBe(STARTS_AT);

    // Deployments query は GSI1 = TENANT#tenant-acme
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");

    // Deployment update が EV1 行のみ走り、EV-OTHER は触らない
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(3);
    const updatedPks = updCmds.map((c) => (c.input.Key as { PK: string }).PK).sort();
    expect(updatedPks).toEqual(["DEPLOYMENT#J1", "DEPLOYMENT#J2", "DEPLOYMENT#J4"]);
    for (const cmd of updCmds) {
      expect(cmd.input.ExpressionAttributeValues?.[":s"]).toBe(STARTS_AT);
    }
  });

  it("Event 行不在 / tenant 不一致は ConditionalCheckFailedException → not_found", async () => {
    const { shared, ddbSend } = buildShared();
    const err = new Error("conditional failed");
    err.name = "ConditionalCheckFailedException";
    ddbSend.mockRejectedValueOnce(err);

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    // Deployments query / update は 1 度も走らない (= 漏洩防止)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("対象 deployment が 0 件でも ok を返し updatedDeployments=0 (= 即座に schedule のみの shortcut)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "ok", startsAt: STARTS_AT, updatedDeployments: 0 });
    // Deployment Update は走らない (Promise.all([]))
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(0);
  });

  it("Event 更新 + 全 deployment update の updatedAt は同じ now 値を使うべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }],
    });
    ddbSend.mockResolvedValue({});

    await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    const deployUpd = ddbSend.mock.calls[2]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
    expect(deployUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
  });
});
