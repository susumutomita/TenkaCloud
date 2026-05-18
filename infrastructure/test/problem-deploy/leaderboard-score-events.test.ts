import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLeaderboardScoreEvents } from "../../lib/problem-deploy/handlers/participant-handler/leaderboard-score-events";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

/**
 * Issue #1038 P1 #6: 全チームの score events を返す endpoint の test。
 * 自チームのみ返す `listScoreEvents` と違い、 event scope で multi-team の event timeline
 * を組む。 期待 shape:
 *
 * ```
 * { eventId, teams: [{teamId, teamName, isMyTeam, events: [...] }] }
 * ```
 */

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
    problemsEndpoints: {},
  };
  return { shared, ddbSend };
}

const meta = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "META",
  GSI1PK: "TENANT#TENANT1",
  GSI1SK: "STATUS#COMPLETE#J1",
  GSI2PK: "TEAMKEY#KEY1",
  tenantId: "TENANT1",
  eventId: "EV1",
  teamId: "TEAM_ME",
  teamName: "team-me",
  displayTeamName: "Team Me",
  jobId: "J1",
  problemId: "p1",
  status: "COMPLETE",
  ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "EVENT#2026-05-08T10:00:00.000Z#01HX",
  jobId: "J1",
  problemId: "p1",
  source: "uptime",
  points: 5,
  result: "ok",
  occurredAt: "2026-05-08T10:00:00.000Z",
  ...over,
});

describe("getLeaderboardScoreEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("自チーム + ライバルチームの events を team 単位で group + occurredAt 昇順で返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: GSI2 (my team) — 1 deployment
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    // 2nd: GSI1 (event 内全 deployment) — me + 2 rivals
    ddbSend.mockResolvedValueOnce({
      Items: [
        meta(),
        meta({
          teamId: "TEAM_A",
          teamName: "team-a",
          displayTeamName: "Alpha",
          PK: "DEPLOYMENT#JA1",
          jobId: "JA1",
        }),
        meta({
          teamId: "TEAM_B",
          teamName: "team-b",
          displayTeamName: "Bravo",
          PK: "DEPLOYMENT#JB1",
          jobId: "JB1",
        }),
      ],
    });
    // 3rd〜: per-deployment EVENT# queries (= 3 並列、 mock 順は Promise.all 起動順)
    // 自チーム J1: 2 events
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({ occurredAt: "2026-05-08T10:02:00.000Z", source: "flag", points: 100 }),
        event({ occurredAt: "2026-05-08T10:01:00.000Z", source: "uptime", points: 5 }),
      ],
    });
    // TEAM_A JA1: 1 event
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          PK: "DEPLOYMENT#JA1",
          jobId: "JA1",
          occurredAt: "2026-05-08T10:00:30.000Z",
          source: "flag",
          points: 200,
        }),
      ],
    });
    // TEAM_B JB1: 1 event
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          PK: "DEPLOYMENT#JB1",
          jobId: "JB1",
          occurredAt: "2026-05-08T10:00:10.000Z",
          source: "flag",
          points: 50,
        }),
      ],
    });

    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const teams = out.response.teams;
    expect(teams).toHaveLength(3);
    // 累計 score 降順: TEAM_A(200) > TEAM_ME(105) > TEAM_B(50)
    expect(teams[0]?.teamId).toBe("TEAM_A");
    expect(teams[0]?.teamName).toBe("Alpha");
    expect(teams[0]?.isMyTeam).toBe(false);
    expect(teams[1]?.teamId).toBe("TEAM_ME");
    expect(teams[1]?.isMyTeam).toBe(true);
    expect(teams[2]?.teamId).toBe("TEAM_B");
    // events 昇順
    expect(teams[1]?.events.map((e) => e.occurredAt)).toEqual([
      "2026-05-08T10:01:00.000Z",
      "2026-05-08T10:02:00.000Z",
    ]);
    expect(out.response.eventId).toBe("EV1");
  });

  it("teamLoginKey 不正 (= GSI2 が空) は unauthorized を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await getLeaderboardScoreEvents(shared, "BAD");
    expect(out).toEqual({ kind: "unauthorized" });
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("自チームに eventId / teamId が無い (= Phase 1 以前の旧 deployment) なら no_event を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [meta({ eventId: undefined, teamId: undefined })],
    });
    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    expect(out).toEqual({ kind: "no_event" });
  });

  it("自チームの deployment が全て DELETING / DELETED なら unauthorized を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [meta({ status: "DELETING" }), meta({ status: "DELETED" })],
    });
    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("hint / flag-wrong / uptime / flag を chart 用 view に含めるべき (= 累計が leaderboard と一致)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({ source: "uptime", points: 5, result: "ok" }),
        event({
          source: "flag",
          points: 100,
          result: "ok",
          occurredAt: "2026-05-08T10:01:00.000Z",
        }),
        event({
          source: "hint",
          points: -30,
          result: "ok",
          occurredAt: "2026-05-08T10:02:00.000Z",
        }),
        event({
          source: "flag-wrong",
          points: -10,
          result: "wrong",
          occurredAt: "2026-05-08T10:03:00.000Z",
        }),
        // attack-detected は marker のみ、 累計 score に影響しないので除外
        event({
          source: "attack-detected",
          points: 0,
          result: "down",
          occurredAt: "2026-05-08T10:04:00.000Z",
        }),
      ],
    });

    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const me = out.response.teams[0];
    expect(me?.events).toHaveLength(4);
    const total = me?.events.reduce((s, e) => s + e.points, 0);
    expect(total).toBe(65); // 5 + 100 - 30 - 10
  });

  it("DELETING / DELETED の deployment は group から除外するべき (= 自チームの archived 行を集計しない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        meta(),
        meta({
          teamId: "TEAM_DEAD",
          PK: "DEPLOYMENT#JDEAD",
          jobId: "JDEAD",
          status: "DELETED",
        }),
      ],
    });
    ddbSend.mockResolvedValueOnce({ Items: [event()] });
    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    if (out.kind !== "ok") throw new Error("expected ok");
    // dead team は teams に出ない
    const teamIds = out.response.teams.map((t) => t.teamId);
    expect(teamIds).not.toContain("TEAM_DEAD");
  });

  it("operator 内部情報 (teamLoginKey / tenantId / awsAccountId / expiresAt) を出力に含めないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          teamId: "TEAMID_LEAK_SENTINEL",
          eventId: "EVENTID_LEAK_SENTINEL",
          tenantId: "TENANTID_LEAK_SENTINEL",
          awsAccountId: "AWSACCOUNT_LEAK_SENTINEL",
          expiresAt: 1_700_000_000_001,
          GSI2PK: "TEAMKEY#SENSITIVE_KEY",
        }),
      ],
    });
    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    if (out.kind !== "ok") throw new Error("expected ok");
    const json = JSON.stringify(out.response);
    expect(json).not.toContain("TEAMID_LEAK_SENTINEL");
    expect(json).not.toContain("EVENTID_LEAK_SENTINEL");
    expect(json).not.toContain("TENANTID_LEAK_SENTINEL");
    expect(json).not.toContain("AWSACCOUNT_LEAK_SENTINEL");
    expect(json).not.toContain("1700000000001");
    expect(json).not.toContain("SENSITIVE_KEY");
    // teamId は ULID として `TEAM_ME` の方は (公開対象なので) 出てる
    expect(json).toContain("TEAM_ME");
  });

  it("EVENT# query は ScanIndexForward=false (= 新しい順) + Limit + PK で発火すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({ Items: [event()] });
    await getLeaderboardScoreEvents(shared, "KEY1");
    const evQuery = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(evQuery.input.ScanIndexForward).toBe(false);
    expect(evQuery.input.KeyConditionExpression).toContain("begins_with(SK, :evpfx)");
    expect(evQuery.input.ExpressionAttributeValues?.[":pk"]).toBe("DEPLOYMENT#J1");
    expect(evQuery.input.ExpressionAttributeValues?.[":evpfx"]).toBe("EVENT#");
  });

  it("複数 deployment / page も読み切って 1 team に集約すべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 自チームに 2 deployment、 events を 2 page にわたって返す
    ddbSend.mockResolvedValueOnce({ Items: [meta(), meta({ PK: "DEPLOYMENT#J2", jobId: "J2" })] });
    ddbSend.mockResolvedValueOnce({
      Items: [meta(), meta({ PK: "DEPLOYMENT#J2", jobId: "J2" })],
    });
    // J1 page1
    ddbSend.mockResolvedValueOnce({
      Items: [event({ occurredAt: "2026-05-08T10:00:00.000Z" })],
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#x" },
    });
    // J1 page2
    ddbSend.mockResolvedValueOnce({
      Items: [event({ occurredAt: "2026-05-08T10:01:00.000Z" })],
    });
    // J2 page1
    ddbSend.mockResolvedValueOnce({
      Items: [event({ PK: "DEPLOYMENT#J2", jobId: "J2", occurredAt: "2026-05-08T10:02:00.000Z" })],
    });

    const out = await getLeaderboardScoreEvents(shared, "KEY1");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.response.teams[0]?.events).toHaveLength(3);
    // 昇順
    expect(out.response.teams[0]?.events.map((e) => e.occurredAt)).toEqual([
      "2026-05-08T10:00:00.000Z",
      "2026-05-08T10:01:00.000Z",
      "2026-05-08T10:02:00.000Z",
    ]);
  });
});
