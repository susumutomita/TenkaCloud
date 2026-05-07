import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEventDetail, listEvents } from "../../lib/problem-deploy/handlers/event-handler/list";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
  };
  return { shared, ddbSend };
}

describe("listEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GSI1 (TENANT#) を新しい順で query するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          eventId: "EV1",
          name: "イベント A",
          status: "DRAFT",
          teamCount: 5,
          problems: [{ problemId: "p1" }, { problemId: "p2" }],
          createdAt: "2026-05-07T08:00:00.000Z",
          updatedAt: "2026-05-07T08:00:00.000Z",
          expiresAt: 9_999_999_999,
        },
      ],
    });

    const out = await listEvents(shared, { tenantId: "tenant-acme" });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input.IndexName).toBe("GSI1");
    expect(cmd.input.KeyConditionExpression).toContain("GSI1PK = :pk");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(cmd.input.ScanIndexForward).toBe(false);

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      eventId: "EV1",
      teamCount: 5,
      problemCount: 2,
    });
  });

  it("LastEvaluatedKey があれば nextCursor を base64url で返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { PK: "EVENT#X", SK: "META" },
    });
    const out = await listEvents(shared, { tenantId: "tenant-acme" });
    expect(out.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(out.nextCursor!, "base64url").toString("utf8"));
    expect(decoded).toEqual({ PK: "EVENT#X", SK: "META" });
  });
});

describe("getEventDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: Event + Teams を返し teamLoginKey も含むべき (詳細経路は露出する)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        name: "イベント A",
        status: "DRAFT",
        teamCount: 2,
        problems: [
          { problemId: "p1", defaultAwsAccountId: "999999999999", defaultRegion: "ap-northeast-1" },
        ],
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", internalSlug: "team-alpha", teamLoginKey: "key-1" },
        { teamId: "T2", internalSlug: "team-beta", teamLoginKey: "key-2" },
      ],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeDefined();
    expect(out?.eventId).toBe("EV1");
    expect(out?.problems).toHaveLength(1);
    expect(out?.teams).toHaveLength(2);
    expect(out?.teams[0]).toMatchObject({
      teamId: "T1",
      internalSlug: "team-alpha",
      teamLoginKey: "key-1",
    });

    // 1 件目は GetCommand (Event)
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    // 2 件目は QueryCommand (Teams)
    const teamsQuery = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(teamsQuery).toBeInstanceOf(QueryCommand);
    expect(teamsQuery.input.KeyConditionExpression).toContain("PK = :pk");
    expect(teamsQuery.input.KeyConditionExpression).toContain("begins_with(SK, :tprefix)");
    expect(teamsQuery.input.ExpressionAttributeValues?.[":pk"]).toBe("EVENT#EV1");
    expect(teamsQuery.input.ExpressionAttributeValues?.[":tprefix"]).toBe("TEAM#");
  });

  it("Event 行が無ければ undefined を返し teams 結果を漏らさないべき", async () => {
    // Get と Query は Promise.all で並列発火するため、Event 不在でも teams query
    // 自体は走る (空 partition なので 1 RCU 程度)。重要なのは結果が caller に返らないこと。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "LEAKED", internalSlug: "leaked", teamLoginKey: "should-not-leak" }],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeUndefined();
  });

  it("tenantId 不一致は undefined を返し teams 結果を漏らさないべき (クロステナント漏洩防止)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-other",
        name: "イベント B",
      },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1", internalSlug: "other-team", teamLoginKey: "other-key" }],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeUndefined();
  });
});
