import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupByTeamLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  GSI2PK: "TEAMKEY#KEY1",
  GSI2SK: "2026-05-04T15:00:00.000Z",
  jobId: "JOB1",
  problemId: "security-battle-royale",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-security-battle-royale-alpha",
  teamLoginKey: "SECRET_DO_NOT_LEAK",
  status: "COMPLETE",
  createdAt: "2026-05-04T15:00:00.000Z",
  updatedAt: "2026-05-04T15:01:00.000Z",
  expiresAt: 1_700_000_000,
  stackOutputs: JSON.stringify({ FrontendUrl: "https://x.example.com" }),
  ...over,
});

describe("lookupByTeamLoginKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GSI2 を TEAMKEY#<key> で Query するべき (Limit=1)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    await lookupByTeamLoginKey(shared, "KEY1");

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe("GSI2");
    expect(cmd.input.KeyConditionExpression).toContain("GSI2PK = :pk");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TEAMKEY#KEY1");
    expect(cmd.input.Limit).toBe(1);
  });

  it("正常系: 公開フィールドのみ返すべき (operator 内部情報 / teamLoginKey は除外)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view).toBeDefined();
    expect(view?.jobId).toBe("JOB1");
    expect(view?.problemId).toBe("security-battle-royale");
    expect(view?.teamName).toBe("Alpha");
    expect(view?.region).toBe("ap-northeast-1");
    expect(view?.status).toBe("COMPLETE");
    expect(view?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });

    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET_DO_NOT_LEAK");
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("999999999999");
    expect(json).not.toContain("namePrefix");
  });

  it("該当行が無ければ undefined", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const view = await lookupByTeamLoginKey(shared, "NOSUCHKEY");
    expect(view).toBeUndefined();
  });

  it("status=DELETING は undefined (認証失敗扱い)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "DELETING" })] });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view).toBeUndefined();
  });

  it("status=DELETED は undefined (認証失敗扱い)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status: "DELETED" })] });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view).toBeUndefined();
  });

  it("status=FAILED のみ failureReason を露出する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "FAILED", failureReason: "VPC limit" })],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.failureReason).toBe("VPC limit");
  });

  it("status=COMPLETE で failureReason が DDB 側に残っていても露出しない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "COMPLETE", failureReason: "stale data" })],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.failureReason).toBeUndefined();
  });

  it("壊れた stackOutputs JSON は空 object として返す (best-effort)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: "not-json" })],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.stackOutputs).toEqual({});
  });
});
