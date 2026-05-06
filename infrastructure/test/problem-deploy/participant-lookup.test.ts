import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupByTeamLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

function buildShared(scoring: ParticipantSharedResources["problemsScoring"] = {}): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: scoring,
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
    expect(view?.teamNameSetByCompetitor).toBe(false);
    expect(view?.region).toBe("ap-northeast-1");
    expect(view?.status).toBe("COMPLETE");
    expect(view?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });

    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET_DO_NOT_LEAK");
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("999999999999");
    expect(json).not.toContain("namePrefix");
  });

  it("displayTeamName が DDB にあれば teamName はそれを優先し teamNameSetByCompetitor=true", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ teamName: "operator-slug", displayTeamName: "わたしたちのチーム" })],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.teamName).toBe("わたしたちのチーム");
    expect(view?.teamNameSetByCompetitor).toBe(true);
  });

  it("displayTeamName が空文字でも未設定扱い (typeof string チェックは通るが trim 後の検証は upstream)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ teamName: "operator-slug", displayTeamName: "" })],
    });
    const view = await lookupByTeamLoginKey(shared, "KEY1");
    // 空文字は string なので typeof check は通り、teamName="" / set=true になる。
    // バリデーションは update.ts が責務。ここでは raw を expose することを担保する。
    expect(view?.teamName).toBe("");
    expect(view?.teamNameSetByCompetitor).toBe(true);
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

  it("flag 形式 problem では flagOutputKey の値を stackOutputs から strip するべき (= 答え露出防止)", async () => {
    const scoring = {
      "security-battle-royale": {
        kind: "flag",
        flagOutputKey: "FlagAnswer",
        points: 100,
      },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          stackOutputs: JSON.stringify({
            FrontendUrl: "https://x.example.com",
            FlagAnswer: "the-secret-answer",
          }),
        }),
      ],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });
    expect(view?.scoring?.kind).toBe("flag");
    expect(view?.scoring?.points).toBe(100);
  });

  it("score / lastScoredAt / lastResult / scoring を participant view に含めるべき", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime", pointsPerSuccess: 50 },
    };
    const { shared, ddbSend } = buildShared(scoring);
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({
          score: 250,
          lastScoredAt: "2026-05-05T10:00:00.000Z",
          lastResult: "ok",
        }),
      ],
    });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.score).toBe(250);
    expect(view?.lastScoredAt).toBe("2026-05-05T10:00:00.000Z");
    expect(view?.lastResult).toBe("ok");
    expect(view?.scoring?.kind).toBe("uptime");
    expect(view?.scoring?.pointsPerSuccess).toBe(50);
  });

  it("score 未設定の row は 0 を返すべき (default)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupByTeamLoginKey(shared, "KEY1");
    expect(view?.score).toBe(0);
  });
});
