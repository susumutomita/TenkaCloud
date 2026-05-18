import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listScoreEvents } from "../../lib/problem-deploy/handlers/participant-handler/score-events";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const meta = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "META",
  GSI2PK: "TEAMKEY#KEY1",
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

describe("listScoreEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: GSI2 で team を引き、各 PK で EVENT# query → occurredAt 降順 merge", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: GSI2 query (team の deployments)
    ddbSend.mockResolvedValueOnce({
      Items: [
        meta({ jobId: "J1", PK: "DEPLOYMENT#J1" }),
        meta({ jobId: "J2", PK: "DEPLOYMENT#J2", problemId: "p2" }),
      ],
    });
    // 2nd & 3rd: 各 PK の EVENT# query (Promise.all)
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({ occurredAt: "2026-05-08T10:00:00.000Z", source: "uptime", points: 5 }),
        event({ occurredAt: "2026-05-08T10:01:00.000Z", source: "uptime", points: 5 }),
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          PK: "DEPLOYMENT#J2",
          jobId: "J2",
          problemId: "p2",
          occurredAt: "2026-05-08T10:00:30.000Z",
          source: "flag",
          points: 100,
        }),
      ],
    });

    const out = await listScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(3);
      // occurredAt 降順
      expect(out.response.entries[0]?.occurredAt).toBe("2026-05-08T10:01:00.000Z");
      expect(out.response.entries[1]?.occurredAt).toBe("2026-05-08T10:00:30.000Z");
      expect(out.response.entries[2]?.occurredAt).toBe("2026-05-08T10:00:00.000Z");
      // flag / uptime 両方含まれる
      expect(out.response.entries[1]).toMatchObject({ source: "flag", points: 100, jobId: "J2" });
    }

    // EVENT# query は ScanIndexForward=false (新しい順)
    const eventQueries = ddbSend.mock.calls.slice(1).map((c) => c[0] as QueryCommand);
    expect(eventQueries[0]?.input.ScanIndexForward).toBe(false);
    expect(eventQueries[0]?.input.KeyConditionExpression).toContain("begins_with(SK, :evpfx)");
    expect(eventQueries[0]?.input.ExpressionAttributeValues?.[":evpfx"]).toBe("EVENT#");
  });

  it("teamLoginKey 不正は unauthorized (= EVENT# query 走らない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await listScoreEvents(shared, "INVALID");
    expect(out).toEqual({ kind: "unauthorized" });
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("全 deployment が DELETING / DELETED は unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [meta({ status: "DELETING" }), meta({ status: "DELETED" })],
    });
    const out = await listScoreEvents(shared, "KEY1");
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("limit を超える merge は上位 N 件で truncate", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    // 5 events
    ddbSend.mockResolvedValueOnce({
      Items: Array.from({ length: 5 }, (_, i) =>
        event({ occurredAt: `2026-05-08T10:0${i}:00.000Z` }),
      ),
    });
    const out = await listScoreEvents(shared, "KEY1", 3);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(3);
    }
  });

  it("不正な event 行 (source 不明 / result fail) は除外", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({ source: "invalid" }),
        event({ result: "fail" }),
        event({ source: "uptime", result: "ok" }),
      ],
    });
    const out = await listScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(1);
    }
  });

  // Issue #1038 P1 #8 follow-up: 旧 toView は uptime/flag のみ通したため、 PR-1043 で書き
  // 込まれる hint 行と Issue #817 で書き込まれる flag-wrong 行が participant の Score events
  // 履歴に表示されなかった。 4 source 全て (= uptime / flag / flag-wrong / hint) を含める。
  it("hint reveal の減点行 (source=hint, result=ok, points=-30) を履歴に含めるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          source: "hint",
          points: -30,
          result: "ok",
          occurredAt: "2026-05-18T10:00:00.000Z",
        }),
      ],
    });
    const out = await listScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(1);
      expect(out.response.entries[0]).toMatchObject({
        source: "hint",
        points: -30,
        result: "ok",
      });
    }
  });

  it("不正解 flag の減点行 (source=flag-wrong, result=wrong, points=-10) を履歴に含めるべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          source: "flag-wrong",
          points: -10,
          result: "wrong",
          occurredAt: "2026-05-18T11:00:00.000Z",
        }),
      ],
    });
    const out = await listScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(1);
      expect(out.response.entries[0]).toMatchObject({
        source: "flag-wrong",
        points: -10,
        result: "wrong",
      });
    }
  });

  it("attack-detected (marker 用、 result=down) は participant 履歴に出さないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({ source: "attack-detected", points: 0, result: "down" }),
        event({ source: "uptime", points: 5, result: "ok" }),
      ],
    });
    const out = await listScoreEvents(shared, "KEY1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(1);
      expect(out.response.entries[0]?.source).toBe("uptime");
    }
  });

  it("attack-detected が 1 page 目を埋め尽くしても次 page を読んで scoring 行を回収する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    // 1 page 目: 全部 attack-detected (= toView で undefined になり 0 件)
    ddbSend.mockResolvedValueOnce({
      Items: Array.from({ length: 3 }, (_, i) =>
        event({
          source: "attack-detected",
          result: "down",
          occurredAt: `2026-05-08T10:0${i}:00.000Z`,
        }),
      ),
      LastEvaluatedKey: { PK: "DEPLOYMENT#J1", SK: "EVENT#x" },
    });
    // 2 page 目: 有効な uptime row
    ddbSend.mockResolvedValueOnce({
      Items: [event({ occurredAt: "2026-05-08T09:00:00.000Z", source: "uptime" })],
    });

    const out = await listScoreEvents(shared, "KEY1", 1);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.response.entries).toHaveLength(1);
      expect(out.response.entries[0]?.source).toBe("uptime");
    }
    // 2 page 目の query には ExclusiveStartKey が乗る
    const secondPage = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(secondPage.input.ExclusiveStartKey).toEqual({ PK: "DEPLOYMENT#J1", SK: "EVENT#x" });
  });

  it("teamId / eventId / tenantId 等 operator 内部情報を出力に含めないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [meta()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        event({
          // 一意で日付タイムスタンプに混ざらない sentinel 値で漏洩 assertion を確実化。
          teamId: "TEAMID_LEAK_SENTINEL",
          eventId: "EVENTID_LEAK_SENTINEL",
          tenantId: "TENANTID_LEAK_SENTINEL",
          expiresAt: 1_700_000_000_001,
        }),
      ],
    });
    const out = await listScoreEvents(shared, "KEY1");
    if (out.kind === "ok") {
      const json = JSON.stringify(out.response);
      expect(json).not.toContain("TEAMID_LEAK_SENTINEL");
      expect(json).not.toContain("EVENTID_LEAK_SENTINEL");
      expect(json).not.toContain("TENANTID_LEAK_SENTINEL");
      expect(json).not.toContain("1700000000001");
    }
  });
});
