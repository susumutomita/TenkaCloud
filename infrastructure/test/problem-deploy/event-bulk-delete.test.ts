import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { type QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend, eventsSend };
}

const dep = (over: Record<string, unknown> = {}) => ({
  jobId: "01HJOBONE",
  eventId: "EV1",
  tenantId: "tenant-acme",
  problemId: "p",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  namePrefix: "tc-p-team-1",
  status: "COMPLETE",
  ...over,
});

describe("bulkTeardownEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: event 配下の deployment を DELETING に更新し DeployDeleteRequested を publish するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({ jobId: "01A", namePrefix: "tc-p-t1" }),
        dep({ jobId: "01B", namePrefix: "tc-p-t2", eventId: "EV1" }),
        dep({ jobId: "01C", namePrefix: "tc-q-t1", eventId: "OTHER" }),
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 2, skipped: 0 },
    });

    // EV1 配下の 2 件だけ Update + publish
    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmds).toHaveLength(2);
    for (const cmd of updateCmds) {
      expect(cmd.input.ExpressionAttributeValues?.[":deleting"]).toBe("DELETING");
      expect(cmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    }

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd.input.Entries).toHaveLength(2);
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
  });

  it("既に DELETING / DELETED な行は skip して publish しないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
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

  it("該当 deployment 0 件かつ event 不在は not_found を返すべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] }); // Deployments query (該当 0)
    ddbSend.mockResolvedValueOnce({ Items: [{ eventId: "OTHER" }] }); // Events query (該当 0)

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("該当 deployment 0 件だが event は存在 (まだ deploy してない) なら enqueued=0 を返すべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({ Items: [{ eventId: "EV1" }] });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 0 } });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("ConditionalCheckFailed (並行更新) は skip して例外を伝播しないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
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
    expect(out).toEqual({ kind: "ok", result: { eventId: "EV1", enqueued: 0, skipped: 1 } });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("Deployments query は GSI1 (TENANT) を引いて in-memory で eventId フィルタするべき (クロステナント漏洩防止)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(eventsSend).not.toHaveBeenCalled();
  });
});
