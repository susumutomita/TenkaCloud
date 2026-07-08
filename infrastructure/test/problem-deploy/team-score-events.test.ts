import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectTeamScoreEvents } from "../../lib/problem-deploy/handlers/event-handler/team-score-events";

/**
 * Issue #1038 P1 #7: operator (= tenant admin) 視点で同 event の全 team の score event
 * timeline をまとめて構築する pure-ish helper の test。 DDB は mock。
 */

function buildShared(): {
  shared: { ddb: { send: ReturnType<typeof vi.fn> }; deploymentsTableName: string };
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared = {
    ddb: { send: ddbSend },
    deploymentsTableName: "TestDeployments",
  };
  return { shared, ddbSend };
}

const ev = (over: Record<string, unknown> = {}) => ({
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

describe("collectTeamScoreEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return multiple teams' events grouped and sorted by occurredAt ascending", async () => {
    const { shared, ddbSend } = buildShared();
    // TEAM_A J1 と TEAM_B J2 — Promise.all なので mock 順は両方発火
    ddbSend.mockResolvedValueOnce({
      Items: [
        ev({ occurredAt: "2026-05-08T10:01:00.000Z", points: 5 }),
        ev({ occurredAt: "2026-05-08T10:00:00.000Z", points: 5 }),
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        ev({
          PK: "DEPLOYMENT#J2",
          jobId: "J2",
          occurredAt: "2026-05-08T10:00:30.000Z",
          source: "flag",
          points: 100,
        }),
      ],
    });

    const teams = await collectTeamScoreEvents(shared, {
      deployments: [
        { jobId: "J1", teamId: "TEAM_A", teamName: "team-a" },
        { jobId: "J2", teamId: "TEAM_B", teamName: "team-b" },
      ],
      displayNameByTeamId: new Map([
        ["TEAM_A", "Alpha"],
        ["TEAM_B", "Bravo"],
      ]),
    });

    // teamId 昇順 sort
    expect(teams.map((t) => t.teamId)).toEqual(["TEAM_A", "TEAM_B"]);
    // displayNameByTeamId を優先
    expect(teams[0]?.teamName).toBe("Alpha");
    expect(teams[1]?.teamName).toBe("Bravo");
    // events 昇順
    expect(teams[0]?.events.map((e) => e.occurredAt)).toEqual([
      "2026-05-08T10:00:00.000Z",
      "2026-05-08T10:01:00.000Z",
    ]);
    expect(teams[1]?.events[0]?.source).toBe("flag");
  });

  it("should include hint / flag-wrong / uptime / flag and exclude attack-detected", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        ev({ source: "uptime", points: 5, result: "ok" }),
        ev({ source: "flag", points: 100, result: "ok" }),
        ev({ source: "hint", points: -30, result: "ok" }),
        ev({ source: "flag-wrong", points: -10, result: "wrong" }),
        ev({ source: "attack-detected", points: 0, result: "down" }),
      ],
    });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "J1", teamId: "TEAM_A" }],
      displayNameByTeamId: new Map(),
    });
    expect(teams[0]?.events).toHaveLength(4);
    const total = teams[0]?.events.reduce((s, e) => s + e.points, 0);
    expect(total).toBe(65); // 5 + 100 - 30 - 10
  });

  it("should drop rows that fail any field validation and keep only well-formed events", async () => {
    const { shared, ddbSend } = buildShared();
    // Each row violates exactly one toView guard (earlier fields stay valid); only the
    // last, fully-formed row should survive.
    ddbSend.mockResolvedValueOnce({
      Items: [
        ev({ jobId: 123 }), // non-string jobId
        ev({ problemId: 123 }), // non-string problemId
        ev({ source: 123 }), // non-string source
        ev({ source: "bogus" }), // source not in the allowed set
        ev({ result: 123 }), // non-string result
        ev({ result: "bogus" }), // result not in the allowed set
        ev({ occurredAt: 123 }), // non-string occurredAt
        ev(), // well-formed → kept
      ],
    });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "J1", teamId: "TEAM_A" }],
      displayNameByTeamId: new Map(),
    });
    expect(teams[0]?.events).toHaveLength(1);
  });

  it("should fall back to teamId when displayName / teamName are absent", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [ev()] });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "J1", teamId: "TEAM_X" }],
      displayNameByTeamId: new Map(),
    });
    expect(teams[0]?.teamName).toBe("TEAM_X");
  });

  it("EVENT# query should fire with ScanIndexForward=false + PK + EVENT# prefix", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [ev()] });
    await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "J1", teamId: "TEAM_A" }],
      displayNameByTeamId: new Map(),
    });
    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.KeyConditionExpression).toContain("begins_with(SK, :evpfx)");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("DEPLOYMENT#J1");
    expect(cmd.input.ExpressionAttributeValues?.[":evpfx"]).toBe("EVENT#");
  });

  it("1 team が複数 deployment / page をまたぐ場合の集約", async () => {
    const { shared, ddbSend } = buildShared();
    // J1 page1 (LastEvaluatedKey 付き) → J1 page2 → J2 page1
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:00:00.000Z" })],
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#x" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:01:00.000Z" })],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ PK: "DEPLOYMENT#J2", jobId: "J2", occurredAt: "2026-05-08T10:02:00.000Z" })],
    });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [
        { jobId: "J1", teamId: "TEAM_A" },
        { jobId: "J2", teamId: "TEAM_A" },
      ],
      displayNameByTeamId: new Map(),
    });
    expect(teams).toHaveLength(1);
    expect(teams[0]?.events.map((e) => e.occurredAt)).toEqual([
      "2026-05-08T10:00:00.000Z",
      "2026-05-08T10:01:00.000Z",
      "2026-05-08T10:02:00.000Z",
    ]);
  });

  it("should cap a single deployment at MAX_PAGES_PER_DEPLOYMENT (3) pages even if more remain", async () => {
    const { shared, ddbSend } = buildShared();
    // 4 ページ全てに LastEvaluatedKey を付けるが、 3 ページ目で打ち止め (= 1 deployment あたりの
    // query 回数を bound)。 4 ページ目は引かれない。
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:00:00.000Z" })],
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#k1" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:01:00.000Z" })],
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#k2" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:02:00.000Z" })],
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#k3" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [ev({ occurredAt: "2026-05-08T10:03:00.000Z" })],
    });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "J1", teamId: "TEAM_A" }],
      displayNameByTeamId: new Map(),
    });
    expect(ddbSend).toHaveBeenCalledTimes(3);
    expect(teams[0]?.events.map((e) => e.occurredAt)).toEqual([
      "2026-05-08T10:00:00.000Z",
      "2026-05-08T10:01:00.000Z",
      "2026-05-08T10:02:00.000Z",
    ]);
    // 2 / 3 ページ目の ExclusiveStartKey は直前ページの LastEvaluatedKey を引き継ぐ。
    const second = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(second.input.ExclusiveStartKey).toEqual({ PK: "DEPLOYMENT#J1", SK: "EVENT#k1" });
    const third = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(third.input.ExclusiveStartKey).toEqual({ PK: "DEPLOYMENT#J1", SK: "EVENT#k2" });
  });

  it("should return empty teams when deployments are empty (no DDB call)", async () => {
    const { shared, ddbSend } = buildShared();
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [],
      displayNameByTeamId: new Map(),
    });
    expect(teams).toHaveLength(0);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("should not include operator-internal info (PK / SK / expiresAt) in output", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        ev({
          PK: "DEPLOYMENT#LEAK_PK_SENTINEL",
          SK: "EVENT#LEAK_SK_SENTINEL",
          tenantId: "LEAK_TENANT_SENTINEL",
          expiresAt: 1_700_000_000_001,
          GSI2PK: "TEAMKEY#LEAK_KEY_SENTINEL",
        }),
      ],
    });
    const teams = await collectTeamScoreEvents(shared, {
      deployments: [{ jobId: "LEAK_PK_SENTINEL", teamId: "TEAM_A" }],
      displayNameByTeamId: new Map(),
    });
    const json = JSON.stringify(teams);
    expect(json).not.toContain("LEAK_PK_SENTINEL");
    expect(json).not.toContain("LEAK_SK_SENTINEL");
    expect(json).not.toContain("LEAK_TENANT_SENTINEL");
    expect(json).not.toContain("LEAK_KEY_SENTINEL");
    expect(json).not.toContain("1700000000001");
  });
});
