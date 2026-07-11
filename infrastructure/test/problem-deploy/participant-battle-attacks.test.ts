import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATTLE_ATTACKS_SINCE_MIN_MAX,
  listBattleAttacks,
} from "../../lib/problem-deploy/handlers/participant-handler/battle-attacks";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const VALID_JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const TEAM_KEY = "KEY1";
const NOW_MS = new Date("2026-05-10T10:00:00.000Z").getTime();

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const teamRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${VALID_JOB_ID}`,
  SK: "META",
  GSI2PK: `TEAMKEY#${TEAM_KEY}`,
  jobId: VALID_JOB_ID,
  problemId: "security-battle-royale",
  status: "COMPLETE",
  ...over,
});

describe("listBattleAttacks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return invalid_jobid for invalid jobId (not ULID form)", async () => {
    const { shared } = buildShared();
    const out = await listBattleAttacks(shared, TEAM_KEY, "not-ulid", 30, NOW_MS);
    expect(out).toEqual({ kind: "invalid_jobid" });
  });

  it("sinceMin が 0 / 負 / 超過 / 非整数 なら invalid_sincemin", async () => {
    const { shared } = buildShared();
    expect((await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 0, NOW_MS)).kind).toBe(
      "invalid_sincemin",
    );
    expect((await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, -1, NOW_MS)).kind).toBe(
      "invalid_sincemin",
    );
    expect(
      (
        await listBattleAttacks(
          shared,
          TEAM_KEY,
          VALID_JOB_ID,
          BATTLE_ATTACKS_SINCE_MIN_MAX + 1,
          NOW_MS,
        )
      ).kind,
    ).toBe("invalid_sincemin");
    expect((await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 1.5, NOW_MS)).kind).toBe(
      "invalid_sincemin",
    );
  });

  it("teamLoginKey が無効 (= deployment 0 件) なら unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("jobId が自 team の deployment にない (= 別 team の jobId 等) なら not_found", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [teamRow({ jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B3" })], // 違う jobId
    });
    const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
  });

  it("正常系: PK=DEPLOYMENT#<jobId> + SK BETWEEN EVENT#<since> AND EVENT#~ で Query (時間窓は key-condition で絞る)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);

    const q = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.KeyConditionExpression).toContain("PK = :pk");
    expect(q.input.KeyConditionExpression).toContain("SK BETWEEN :sk_start AND :sk_end");
    expect(q.input.ExpressionAttributeValues?.[":pk"]).toBe(`DEPLOYMENT#${VALID_JOB_ID}`);
    // since = NOW − 30 分 = "2026-05-10T09:30:00.000Z"
    expect(q.input.ExpressionAttributeValues?.[":sk_start"]).toBe("EVENT#2026-05-10T09:30:00.000Z");
    expect(q.input.ExpressionAttributeValues?.[":sk_end"]).toBe("EVENT#~");
    // FilterExpression は使わず key condition のみ (post-read filter で RCU 暴発しないように)
    expect(q.input.FilterExpression).toBeUndefined();
    expect(q.input.ScanIndexForward).toBe(false);
  });

  it("DELETING / DELETED 状態の deployment 行は target にしない (= teardown 中の sparse 残骸対策)", async () => {
    for (const status of ["DELETING", "DELETED"] as const) {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [teamRow({ status })] });
      const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);
      expect(out).toEqual({ kind: "not_found" });
      // 1 回目 (queryTeamItems) のみ呼ばれて event query には到達しない
      expect(ddbSend).toHaveBeenCalledTimes(1);
    }
  });

  it("LastEvaluatedKey があれば paginate して残りの page も読む", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { source: "attack-detected", occurredAt: "2026-05-10T09:55:00.000Z", result: "down" },
      ],
      LastEvaluatedKey: { PK: "x", SK: "y" },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { source: "attack-detected", occurredAt: "2026-05-10T09:35:00.000Z", result: "down" },
      ],
    });

    const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.events).toHaveLength(2);
    // 2 page 目への ExclusiveStartKey が指定されている
    const secondPage = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(secondPage.input.ExclusiveStartKey).toEqual({ PK: "x", SK: "y" });
  });

  it("attack-detected event を時系列降順で返し、後続 uptime event を recoveredAt として結合する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        // 14:32 attack → 14:35 uptime で復旧
        {
          source: "attack-detected",
          occurredAt: "2026-05-10T09:32:00.000Z",
          result: "down",
        },
        {
          source: "uptime",
          occurredAt: "2026-05-10T09:35:00.000Z",
          result: "ok",
        },
        // 14:42 attack → 後続 uptime 無し = 未復旧
        {
          source: "attack-detected",
          occurredAt: "2026-05-10T09:42:00.000Z",
          result: "down",
        },
        // 別種の event は無視 (attack のみ返す)
        {
          source: "flag",
          occurredAt: "2026-05-10T09:55:00.000Z",
          result: "ok",
        },
      ],
    });

    const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 30, NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.events).toHaveLength(2);
    // 降順
    expect(out.response.events[0]?.occurredAt).toBe("2026-05-10T09:42:00.000Z");
    expect(out.response.events[0]?.recoveredAt).toBeNull(); // 未復旧
    expect(out.response.events[1]?.occurredAt).toBe("2026-05-10T09:32:00.000Z");
    expect(out.response.events[1]?.recoveredAt).toBe("2026-05-10T09:35:00.000Z"); // 復旧
  });

  it("response shape: jobId / problemId / sinceMin / events のみで内部情報を露出しない", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [teamRow({ tenantId: "tenant-acme", teamLoginKey: "SECRET", namePrefix: "tc-x" })],
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await listBattleAttacks(shared, TEAM_KEY, VALID_JOB_ID, 15, NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response).toEqual({
      jobId: VALID_JOB_ID,
      problemId: "security-battle-royale",
      sinceMin: 15,
      events: [],
    });
    const json = JSON.stringify(out.response);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("namePrefix");
  });
});
