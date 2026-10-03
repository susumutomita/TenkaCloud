import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveEvent } from "../../lib/problem-deploy/handlers/event-handler/archive";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
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

describe("archiveEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case (DRAFT): should SET status to ARCHIVED and archivedAt = now", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "ok", archivedAt: NOW_ISO });

    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.UpdateExpression).toContain("#s = :archived");
    expect(cmd.input.UpdateExpression).toContain("archivedAt = :now");
    expect(cmd.input.ExpressionAttributeValues?.[":archived"]).toBe("ARCHIVED");
    expect(cmd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
    // ConditionExpression が tenantId 一致 + status IN (DRAFT/ENDED/TEARDOWN) を要求
    expect(cmd.input.ConditionExpression).toBe(
      "tenantId = :tenantId AND #s IN (:draft, :ended, :teardown)",
    );
    expect(cmd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    expect(cmd.input.ExpressionAttributeValues?.[":draft"]).toBe("DRAFT");
    expect(cmd.input.ExpressionAttributeValues?.[":ended"]).toBe("ENDED");
    expect(cmd.input.ExpressionAttributeValues?.[":teardown"]).toBe("TEARDOWN");
    // probe Get は走らない (= 1 回で完結)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("status=READY (進行中) は not_archivable で 409 相当", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-acme", status: "READY" },
    });

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_archivable", status: "READY" });
    expect(ddbSend.mock.calls[1]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("status=DEPLOYING も not_archivable", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-acme", status: "DEPLOYING" },
    });

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_archivable", status: "DEPLOYING" });
  });

  it("status=ARCHIVED への二重 archive も not_archivable (= 冪等にせずレース防止を露出)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-acme", status: "ARCHIVED" },
    });

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_archivable", status: "ARCHIVED" });
  });

  it("Event 行不在は not_found", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
  });

  it("tenant 不一致は not_found (cross-tenant 漏洩防止 = status を露出しない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(conditionalFailure());
    ddbSend.mockResolvedValueOnce({
      Item: { eventId: "EV1", tenantId: "tenant-other", status: "DRAFT" },
    });

    const out = await archiveEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
  });

  it("ConditionalCheckFailedException 以外の DDB エラーは throw", async () => {
    const { shared, ddbSend } = buildShared();
    const transient = new Error("ProvisionedThroughputExceededException");
    transient.name = "ProvisionedThroughputExceededException";
    ddbSend.mockRejectedValueOnce(transient);

    await expect(archiveEvent(shared, "tenant-acme", "EV1", NOW_MS)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});
