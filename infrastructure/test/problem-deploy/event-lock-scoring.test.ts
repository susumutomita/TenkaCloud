import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lockScoring,
  unlockScoring,
} from "../../lib/problem-deploy/handlers/event-handler/lock-scoring";
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
    eventBusName: "TestBus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: {} as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

describe("lockScoring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("READY + 未 lock 状態のとき scoringLocked=true / scoringLockedAt / scoringLockedBy を SET し ok を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { tenantId: "t1", status: "READY", scoringLocked: true },
    });

    const out = await lockScoring(
      shared,
      "t1",
      "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      "sub-operator",
      NOW_MS,
    );

    expect(out).toEqual({ kind: "ok", scoringLocked: true, scoringLockedAt: NOW_ISO });
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input.TableName).toBe("TestEvents");
    expect(cmd.input.UpdateExpression).toContain("scoringLocked = :t");
    expect(cmd.input.ExpressionAttributeValues?.[":t"]).toBe(true);
    expect(cmd.input.ExpressionAttributeValues?.[":who"]).toBe("sub-operator");
    expect(cmd.input.ConditionExpression).toContain("tenantId = :tenantId");
  });

  it("ENDED 状態でも lock 可能であるべき (= 表彰フェーズ用途)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { tenantId: "t1", status: "ENDED", scoringLocked: true },
    });

    const out = await lockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", "sub-op", NOW_MS);

    expect(out.kind).toBe("ok");
    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd.input.ConditionExpression).toContain(":ended");
  });

  it("ConditionalCheckFailed + 行不在のとき not_found を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend.mockRejectedValueOnce(err).mockResolvedValueOnce({ Item: undefined });

    const out = await lockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", "sub", NOW_MS);

    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls[1]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("ConditionalCheckFailed + tenant 不一致のとき not_found を返すべき (= tenant 跨ぎ防止)", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { tenantId: "other-tenant", status: "READY" } });

    const out = await lockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", "sub", NOW_MS);

    expect(out).toEqual({ kind: "not_found" });
  });

  it("ConditionalCheckFailed + status=DRAFT のとき not_lockable を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { tenantId: "t1", status: "DRAFT" } });

    const out = await lockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", "sub", NOW_MS);

    expect(out).toEqual({ kind: "not_lockable", status: "DRAFT" });
  });

  it("ConditionalCheckFailed + 既に lock 済のとき already を返すべき (= idempotent)", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend.mockRejectedValueOnce(err).mockResolvedValueOnce({
      Item: { tenantId: "t1", status: "READY", scoringLocked: true },
    });

    const out = await lockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", "sub", NOW_MS);

    expect(out).toEqual({ kind: "already", scoringLocked: true });
  });
});

describe("unlockScoring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lock 済 + READY のとき scoringLocked を REMOVE し ok を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { tenantId: "t1", status: "READY" },
    });

    const out = await unlockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", NOW_MS);

    expect(out).toEqual({ kind: "ok", scoringLocked: false });
    const cmd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(cmd.input.UpdateExpression).toContain("REMOVE scoringLocked");
    expect(cmd.input.UpdateExpression).toContain("scoringLockedAt");
    expect(cmd.input.UpdateExpression).toContain("scoringLockedBy");
    expect(cmd.input.ConditionExpression).toContain("scoringLocked = :t");
  });

  it("そもそも unlocked のとき already を返すべき (= idempotent)", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend.mockRejectedValueOnce(err).mockResolvedValueOnce({
      Item: { tenantId: "t1", status: "READY" },
    });

    const out = await unlockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", NOW_MS);

    expect(out).toEqual({ kind: "already", scoringLocked: false });
  });

  it("status=ARCHIVED で lock=true のとき not_lockable を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    const err = Object.assign(new Error("Condition"), { name: "ConditionalCheckFailedException" });
    ddbSend.mockRejectedValueOnce(err).mockResolvedValueOnce({
      Item: { tenantId: "t1", status: "ARCHIVED", scoringLocked: true },
    });

    const out = await unlockScoring(shared, "t1", "01HZX0K3M3K9ZQHB3MRQHBA1B2", NOW_MS);

    expect(out).toEqual({ kind: "not_lockable", status: "ARCHIVED" });
  });
});
