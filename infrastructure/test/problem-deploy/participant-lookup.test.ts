import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupTeamByLoginKey } from "../../lib/problem-deploy/handlers/participant-handler/lookup";
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

describe("lookupTeamByLoginKey (Phase 2c team scope)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GSI2 を TEAMKEY#<key> で Query するべき (Limit なし、team scope の全行を取る)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    await lookupTeamByLoginKey(shared, "KEY1");

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe("GSI2");
    expect(cmd.input.KeyConditionExpression).toContain("GSI2PK = :pk");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TEAMKEY#KEY1");
    // team scope なので Limit は付けない (= team の全 problems を 1 query で取る)
    expect(cmd.input.Limit).toBeUndefined();
  });

  it("正常系: team + problems[] を返し、operator 内部情報 / teamLoginKey を漏らさない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view).toBeDefined();
    expect(view?.team.teamName).toBe("Alpha");
    expect(view?.team.teamNameSetByCompetitor).toBe(false);
    expect(view?.problems).toHaveLength(1);
    expect(view?.problems[0]?.jobId).toBe("JOB1");
    expect(view?.problems[0]?.problemId).toBe("security-battle-royale");
    expect(view?.problems[0]?.region).toBe("ap-northeast-1");
    expect(view?.problems[0]?.status).toBe("COMPLETE");
    expect(view?.problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });

    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET_DO_NOT_LEAK");
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("999999999999");
    expect(json).not.toContain("namePrefix");
  });

  it("displayTeamName が DDB にあれば team.teamName はそれを優先し teamNameSetByCompetitor=true", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ teamName: "operator-slug", displayTeamName: "わたしたちのチーム" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.teamName).toBe("わたしたちのチーム");
    expect(view?.team.teamNameSetByCompetitor).toBe(true);
  });

  it("Phase 2a 経由の eventId / teamId 列が team に伝播するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ eventId: "EV1", teamId: "T1" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.eventId).toBe("EV1");
    expect(view?.team.teamId).toBe("T1");
  });

  it("旧 jobId-based deployment (eventId / teamId 無し) は team.eventId/teamId が undefined", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.team.eventId).toBeUndefined();
    expect(view?.team.teamId).toBeUndefined();
  });

  it("該当行が無ければ undefined", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const view = await lookupTeamByLoginKey(shared, "NOSUCHKEY");
    expect(view).toBeUndefined();
  });

  it("全行が DELETING / DELETED は undefined (sparse 化が崩れた場合の防御)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "DELETING" }), sampleRow({ jobId: "JOB2", status: "DELETED" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view).toBeUndefined();
  });

  it("一部だけ DELETED な team は live な行のみで problems[] を構築するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "JOB1", problemId: "p1", status: "COMPLETE" }),
        sampleRow({ jobId: "JOB2", problemId: "p2", status: "DELETED" }),
        sampleRow({ jobId: "JOB3", problemId: "p3", status: "PENDING" }),
      ],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems).toHaveLength(2);
    expect(view?.problems.map((p) => p.problemId).sort()).toEqual(["p1", "p3"]);
  });

  it("status=FAILED のみ failureReason を露出する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "FAILED", failureReason: "VPC limit" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.failureReason).toBe("VPC limit");
  });

  it("status=COMPLETE で failureReason が DDB 側に残っていても露出しない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "COMPLETE", failureReason: "stale data" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.failureReason).toBeUndefined();
  });

  it("壊れた stackOutputs JSON は空 object として返す (best-effort)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: "not-json" })],
    });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.stackOutputs).toEqual({});
  });

  it("flag 形式 problem では flagOutputKey の値を stackOutputs から strip するべき (= 答え露出防止)", async () => {
    const scoring = {
      "security-battle-royale": {
        kind: "flag" as const,
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

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.stackOutputs).toEqual({ FrontendUrl: "https://x.example.com" });
    expect(view?.problems[0]?.scoring?.kind).toBe("flag");
    expect(view?.problems[0]?.scoring?.points).toBe(100);
  });

  it("score / lastScoredAt / lastResult / scoring を problem view に含めるべき", async () => {
    const scoring = {
      "security-battle-royale": { kind: "uptime" as const, pointsPerSuccess: 50 },
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

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    const p = view?.problems[0];
    expect(p?.score).toBe(250);
    expect(p?.lastScoredAt).toBe("2026-05-05T10:00:00.000Z");
    expect(p?.lastResult).toBe("ok");
    expect(p?.scoring?.kind).toBe("uptime");
    expect(p?.scoring?.pointsPerSuccess).toBe(50);
  });

  it("score 未設定の row は 0 を返すべき (default)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });

    const view = await lookupTeamByLoginKey(shared, "KEY1");
    expect(view?.problems[0]?.score).toBe(0);
  });
});
