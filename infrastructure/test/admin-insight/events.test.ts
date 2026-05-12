import { GetCommand, type QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEventDetailForTenant,
  listEventsForTenant,
  redactTeams,
} from "../../lib/admin-insight/handlers/admin-insight-handler/events";

function buildShared(send: ReturnType<typeof vi.fn>) {
  return {
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
  };
}

describe("listEventsForTenant (ADR-011 / #598 Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Events table を GSI1 で query して EventSummary 配列を返すべき", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
          name: "Event A",
          status: "READY",
          teamCount: 3,
          problems: [{ problemId: "p1" }],
          createdAt: "2026-05-11T00:00:00.000Z",
          updatedAt: "2026-05-11T01:00:00.000Z",
          expiresAt: 0,
        },
      ],
    });
    const result = await listEventsForTenant(buildShared(send), { tenantId: "t1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Event A");
    expect(result.items[0].problemCount).toBe(1);
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd.input.TableName).toBe("TestEvents");
    expect(cmd.input.IndexName).toBe("GSI1");
    expect(cmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#t1");
    expect(cmd.input.ScanIndexForward).toBe(false);
  });

  it("LastEvaluatedKey があれば nextCursor を base64url で encode するべき", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Items: [], LastEvaluatedKey: { PK: "EVENT#x", SK: "META" } });
    const result = await listEventsForTenant(buildShared(send), { tenantId: "t1" });
    const cursor = result.nextCursor;
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error("nextCursor was undefined");
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    expect(decoded).toEqual({ PK: "EVENT#x", SK: "META" });
  });

  it("limit は 1..200 の範囲に clamp するべき", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await listEventsForTenant(buildShared(send), { tenantId: "t1", limit: 9999 });
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd.input.Limit).toBe(200);
  });
});

describe("redactTeams (security regression pin)", () => {
  it("teamLoginKey を **必ず** undefined に潰すべき (ADR-011 D2)", () => {
    const result = redactTeams([
      {
        teamId: "t1",
        internalSlug: "team-a",
        teamLoginKey: "secret-bearer-DO-NOT-LEAK",
      },
    ]);
    expect(result[0].teamLoginKey).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret-bearer-DO-NOT-LEAK");
  });

  it("displayName / awsAccountId / internalSlug は素通しするべき (= read-only mirror)", () => {
    const result = redactTeams([
      {
        teamId: "t1",
        internalSlug: "team-a",
        displayName: "Alpha",
        awsAccountId: "123456789012",
        teamLoginKey: "shhh",
      },
    ]);
    expect(result[0]).toMatchObject({
      teamId: "t1",
      internalSlug: "team-a",
      displayName: "Alpha",
      awsAccountId: "123456789012",
    });
  });
});

describe("getEventDetailForTenant (ADR-011 / #598 Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  const eventItem = {
    PK: "EVENT#01HZX0K3M3K9ZQHB3MRQHBA1B2",
    SK: "META",
    eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
    tenantId: "t1",
    name: "My Event",
    status: "READY",
    teamCount: 2,
    problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T01:00:00.000Z",
    expiresAt: 0,
  };

  function send3(
    eventOut: unknown,
    teamsOut: unknown,
    deploysOut: unknown,
  ): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation(async (cmd: GetCommand | QueryCommand) => {
      if (cmd instanceof GetCommand) return eventOut;
      const input = (cmd as QueryCommand).input;
      if (input.TableName === "TestTeams") return teamsOut;
      if (input.TableName === "TestDeployments") return deploysOut;
      throw new Error(`unexpected: ${JSON.stringify(input)}`);
    });
  }

  it("Event 不在なら undefined を返すべき (= 404 相当)", async () => {
    const send = send3({ Item: undefined }, { Items: [] }, { Items: [] });
    const result = await getEventDetailForTenant(buildShared(send), "t1", eventItem.eventId);
    expect(result).toBeUndefined();
  });

  it("tenantId 不一致なら undefined を返すべき (= cross-tenant 漏洩防止)", async () => {
    const send = send3({ Item: { ...eventItem, tenantId: "OTHER" } }, { Items: [] }, { Items: [] });
    const result = await getEventDetailForTenant(buildShared(send), "t1", eventItem.eventId);
    expect(result).toBeUndefined();
  });

  it("teams[].teamLoginKey は response に乗らないべき (security regression pin)", async () => {
    const send = send3(
      { Item: eventItem },
      {
        Items: [
          {
            teamId: "team-1",
            internalSlug: "team-alpha",
            teamLoginKey: "SECRET-DO-NOT-LEAK",
            displayName: "Alpha",
          },
        ],
      },
      { Items: [] },
    );
    const result = await getEventDetailForTenant(buildShared(send), "t1", eventItem.eventId);
    expect(result).toBeDefined();
    expect(result?.teams[0].teamLoginKey).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET-DO-NOT-LEAK");
  });

  it("Deployments を problemId ごとに集約し、displayTeamName を teams[] に転記するべき", async () => {
    const send = send3(
      { Item: eventItem },
      {
        Items: [
          { teamId: "team-1", internalSlug: "team-alpha" },
          { teamId: "team-2", internalSlug: "team-beta" },
        ],
      },
      {
        Items: [
          {
            eventId: eventItem.eventId,
            teamId: "team-1",
            problemId: "p1",
            jobId: "job-1",
            status: "COMPLETE",
            displayTeamName: "AlphaDisplay",
          },
          {
            eventId: eventItem.eventId,
            teamId: "team-2",
            problemId: "p1",
            jobId: "job-2",
            status: "FAILED",
          },
          // 別 event の row は無視されるべき
          {
            eventId: "OTHER",
            teamId: "team-1",
            problemId: "p1",
            jobId: "job-99",
            status: "COMPLETE",
          },
        ],
      },
    );
    const result = await getEventDetailForTenant(buildShared(send), "t1", eventItem.eventId);
    expect(result?.deploymentsByProblem.p1).toHaveLength(2);
    expect(result?.deploymentsByProblem.p1.map((d) => d.jobId)).toEqual(["job-1", "job-2"]);
    const team1 = result?.teams.find((t) => t.teamId === "team-1");
    expect(team1?.displayName).toBe("AlphaDisplay");
  });
});
