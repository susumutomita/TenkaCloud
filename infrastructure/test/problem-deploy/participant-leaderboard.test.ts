import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLeaderboardEntries,
  getLeaderboard,
} from "../../lib/problem-deploy/handlers/participant-handler/leaderboard";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "META",
  GSI2PK: "TEAMKEY#KEY1",
  jobId: "J1",
  problemId: "p1",
  tenantId: "tenant-acme",
  eventId: "EV1",
  teamId: "T1",
  teamName: "team-1",
  region: "ap-northeast-1",
  status: "COMPLETE",
  score: 100,
  ...over,
});

describe("buildLeaderboardEntries (pure)", () => {
  it("空 items は空配列を返す", () => {
    expect(buildLeaderboardEntries([], "T1")).toEqual([]);
  });

  it("複数 team / 複数 problem を team で集計しスコア降順 + rank 付与するべき", () => {
    const items = [
      sampleRow({ teamId: "T1", problemId: "p1", score: 100, status: "COMPLETE" }),
      sampleRow({ teamId: "T1", problemId: "p2", score: 50, status: "COMPLETE" }),
      sampleRow({ teamId: "T2", problemId: "p1", score: 200, status: "COMPLETE" }),
      sampleRow({ teamId: "T2", problemId: "p2", score: 0, status: "PENDING" }),
      sampleRow({ teamId: "T3", problemId: "p1", score: 150, status: "COMPLETE" }),
    ];
    const out = buildLeaderboardEntries(items, "T1");
    expect(out).toHaveLength(3);
    // T2: 200 → 1 位、T3: 150 → 2 位、T1: 150 → 3 位 (T3 と T1 は 150 同点、teamName 昇順で T1 < T3)
    expect(out[0]).toMatchObject({ rank: 1, teamId: "T2", score: 200, completedProblems: 1 });
    expect(out[1]).toMatchObject({ rank: 2, teamId: "T1", score: 150, completedProblems: 2 });
    expect(out[2]).toMatchObject({ rank: 3, teamId: "T3", score: 150 });
  });

  it("isMyTeam=true で自分の team をマークするべき (UI ハイライト用)", () => {
    const items = [
      sampleRow({ teamId: "T1", problemId: "p1", score: 100 }),
      sampleRow({ teamId: "T2", problemId: "p1", score: 200 }),
    ];
    const out = buildLeaderboardEntries(items, "T2");
    expect(out.find((e) => e.teamId === "T2")?.isMyTeam).toBe(true);
    expect(out.find((e) => e.teamId === "T1")?.isMyTeam).toBe(false);
  });

  it("displayTeamName を採用、無ければ teamName (operator slug) を fallback", () => {
    const items = [
      sampleRow({ teamId: "T1", teamName: "team-1", displayTeamName: "わたしたちのチーム" }),
      sampleRow({ teamId: "T2", teamName: "team-2" }), // displayName 無し
    ];
    const out = buildLeaderboardEntries(items, "T1");
    expect(out.find((e) => e.teamId === "T1")?.teamName).toBe("わたしたちのチーム");
    expect(out.find((e) => e.teamId === "T2")?.teamName).toBe("team-2");
  });

  it("DELETING / DELETED 行は集計から除外するべき", () => {
    const items = [
      sampleRow({ teamId: "T1", score: 100, status: "COMPLETE" }),
      sampleRow({ teamId: "T1", score: 999, status: "DELETING" }),
      sampleRow({ teamId: "T1", score: 999, status: "DELETED" }),
    ];
    const out = buildLeaderboardEntries(items, "T1");
    expect(out[0]?.score).toBe(100);
    expect(out[0]?.totalProblems).toBe(1);
  });

  it("teamId 不在の行は無視 (旧 jobId-based deployment 防御)", () => {
    const items = [
      sampleRow({ teamId: undefined, score: 999 }),
      sampleRow({ teamId: "T1", score: 100 }),
    ];
    const out = buildLeaderboardEntries(items, "T1");
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(100);
  });

  it("score / completedProblems の集計が正しいべき", () => {
    const items = [
      sampleRow({ teamId: "T1", problemId: "p1", score: 100, status: "COMPLETE" }),
      sampleRow({ teamId: "T1", problemId: "p2", score: 50, status: "COMPLETE" }),
      sampleRow({ teamId: "T1", problemId: "p3", score: 30, status: "FAILED" }),
      sampleRow({ teamId: "T1", problemId: "p4", score: 0, status: "PENDING" }),
    ];
    const out = buildLeaderboardEntries(items, "T1");
    expect(out[0]).toMatchObject({
      score: 180,
      completedProblems: 2, // p1 + p2
      totalProblems: 4,
    });
  });

  it("teamLoginKey / tenantId / awsAccountId 等 operator 内部情報を出力に含めないべき", () => {
    const items = [
      sampleRow({
        teamId: "T1",
        teamLoginKey: "SECRET_DO_NOT_LEAK",
        tenantId: "tenant-acme",
        awsAccountId: "999999999999",
      }),
    ];
    const out = buildLeaderboardEntries(items, "T1");
    const json = JSON.stringify(out);
    expect(json).not.toContain("SECRET_DO_NOT_LEAK");
    expect(json).not.toContain("tenant-acme");
    expect(json).not.toContain("999999999999");
  });
});

describe("getLeaderboard (integration)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: team scope query → event scope query → 集計 view を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: GSI2 query (自 team の deployment)
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ teamId: "T1", eventId: "EV1", tenantId: "tenant-acme" })],
    });
    // 2nd: GSI1 query (event 全体の deployment)
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ teamId: "T1", problemId: "p1", score: 100, status: "COMPLETE" }),
        sampleRow({ teamId: "T2", problemId: "p1", score: 200, status: "COMPLETE" }),
      ],
    });

    const out = await getLeaderboard(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.eventId).toBe("EV1");
      expect(out.response.entries).toHaveLength(2);
      expect(out.response.entries[0]).toMatchObject({ rank: 1, teamId: "T2", score: 200 });
      expect(out.response.entries[1]).toMatchObject({
        rank: 2,
        teamId: "T1",
        score: 100,
        isMyTeam: true,
      });
    }

    // GSI1 query は FilterExpression で eventId 一致を要求
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.FilterExpression).toBe("eventId = :ev");
    expect(queryCmd.input.ExpressionAttributeValues?.[":ev"]).toBe("EV1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
  });

  it("teamLoginKey が無効なら unauthorized (= GSI1 query しない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await getLeaderboard(shared, "INVALID");
    expect(out).toEqual({ kind: "unauthorized" });
    expect(ddbSend).toHaveBeenCalledTimes(1); // GSI1 query 走らない
  });

  it("自 team の全行が DELETING / DELETED なら unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ status: "DELETING" }), sampleRow({ status: "DELETED" })],
    });
    const out = await getLeaderboard(shared, "KEY1");
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("Phase 1 以前 (eventId 無し) の旧 deployment は no_event を返す", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ eventId: undefined, teamId: undefined })],
    });
    const out = await getLeaderboard(shared, "KEY1");
    expect(out).toEqual({ kind: "no_event" });
  });
});
