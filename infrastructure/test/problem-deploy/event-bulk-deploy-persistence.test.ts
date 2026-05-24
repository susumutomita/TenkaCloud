import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDeployEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-deploy";
import { buildShared, NOW_MS, sampleEvent, sampleTeams } from "./event-bulk-deploy.test-helpers";

describe("bulkDeployEvent — persistence: row shape & Event status flip", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should denormalize Event.startsAt into the deployment row as eventStartsAt", async () => {
    // operator が Bulk Deploy 前に schedule 済 (startsAt 設定済) だった場合、
    // 新規 deployment 行が gate 値を持って作られるシナリオ。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleEvent({ startsAt: "2026-05-08T10:00:00.000Z" }),
    });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find(
        (c): c is TransactWriteCommand => c instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.Item?.eventStartsAt).toBe("2026-05-08T10:00:00.000Z");
    }
  });

  it("should leave eventStartsAt undefined when Event.startsAt is unset (score gate side)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // startsAt 無し
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find(
        (c): c is TransactWriteCommand => c instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
    for (const item of transactCmd.input.TransactItems ?? []) {
      expect(item.Put?.Item?.eventStartsAt).toBeUndefined();
    }
  });

  it("should use the team awsAccountId for the deployment row's awsAccountId (#528)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(2) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);

    const transactCmd = ddbSend.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0];
    const items = (transactCmd as TransactWriteCommand).input.TransactItems ?? [];
    // 2 teams × 2 problems = 4 items
    expect(items).toHaveLength(4);
    // T1 (awsAccountId=111111111111) と T2 (awsAccountId=222222222222) で別 account に
    const accountsByTeam = new Map<string, Set<string>>();
    for (const it of items) {
      const teamId = String(it.Put?.Item?.teamId ?? "");
      const acct = String(it.Put?.Item?.awsAccountId ?? "");
      if (!accountsByTeam.has(teamId)) accountsByTeam.set(teamId, new Set());
      accountsByTeam.get(teamId)?.add(acct);
    }
    // T1 の 2 deploy はすべて 111111111111、T2 の 2 deploy はすべて 222222222222
    expect([...(accountsByTeam.get("T1") ?? [])]).toEqual(["111111111111"]);
    expect([...(accountsByTeam.get("T2") ?? [])]).toEqual(["222222222222"]);
  });

  it("should fall back to problem.defaultAwsAccountId when team.awsAccountId is absent (#528 migration)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    // sampleTeams から awsAccountId を意図的に外す (旧 Event)
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
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const transactCmd = ddbSend.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0];
    const items = (transactCmd as TransactWriteCommand).input.TransactItems ?? [];
    expect(items.length).toBeGreaterThan(0);
    // problem.defaultAwsAccountId (= 999999999999、sampleEvent 内) に fallback
    for (const it of items) {
      expect(it.Put?.Item?.awsAccountId).toBe("999999999999");
    }
  });

  it("should flip Event status DRAFT → DEPLOYING after success (for status-badge visibility)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: sampleTeams(1) });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkDeployEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmds).toHaveLength(1);
    const cmd = updateCmds[0] as UpdateCommand;
    expect(cmd.input.UpdateExpression).toContain("#status = :deploying");
    expect(cmd.input.ExpressionAttributeValues?.[":deploying"]).toBe("DEPLOYING");
    // TEARDOWN/ARCHIVED は触らない (ConditionExpression で DRAFT/READY/DEPLOYING のみ許可)
    expect(cmd.input.ExpressionAttributeValues?.[":draft"]).toBe("DRAFT");
    expect(cmd.input.ExpressionAttributeValues).not.toHaveProperty(":teardown");
    // #872: tenantId condition で他 tenant の event を踏み越えない defense-in-depth
    expect(cmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    expect(cmd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
  });
});
