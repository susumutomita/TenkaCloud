import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEventDetail, listEvents } from "../../lib/problem-deploy/handlers/event-handler/list";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: vi.fn() } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

describe("listEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should query GSI1 (TENANT#) in newest-first order", async () => {
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

  it("should return nextCursor as base64url when LastEvaluatedKey is present", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { PK: "EVENT#X", SK: "META" },
    });
    const out = await listEvents(shared, { tenantId: "tenant-acme" });
    expect(out.nextCursor).toBeTruthy();
    if (!out.nextCursor) throw new Error("nextCursor should be set");
    const decoded = JSON.parse(Buffer.from(out.nextCursor, "base64url").toString("utf8"));
    expect(decoded).toEqual({ PK: "EVENT#X", SK: "META" });
  });

  it("should forward a valid cursor as ExclusiveStartKey", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const startKey = { PK: "EVENT#Y", SK: "META" };
    const cursor = Buffer.from(JSON.stringify(startKey), "utf8").toString("base64url");

    await listEvents(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toEqual(startKey);
  });

  it("Issue #862: should ignore cursors with keys outside the allowlist (injection guard)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const evil = { PK: "EVENT#X", SK: "META", evilAttribute: "exfil" };
    const cursor = Buffer.from(JSON.stringify(evil), "utf8").toString("base64url");

    await listEvents(shared, { tenantId: "tenant-acme", cursor });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("Issue #862: should ignore overly long cursors (DoS guard)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    await listEvents(shared, { tenantId: "tenant-acme", cursor: "a".repeat(1024) });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });

  it("should ignore malformed cursors and start from the beginning", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    await listEvents(shared, { tenantId: "tenant-acme", cursor: "!!!not-valid!!!" });

    const cmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
  });
});

describe("getEventDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case: should return Event + Teams without re-exposing teamLoginKey", async () => {
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
    // Deployments query (3rd parallel call) — 競技者がまだ portal で名前を設定して
    // いないので displayTeamName 行は無し。
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeDefined();
    expect(out?.eventId).toBe("EV1");
    expect(out?.problems).toHaveLength(1);
    expect(out?.teams).toHaveLength(2);
    expect(out?.teams[0]).toEqual({
      teamId: "T1",
      internalSlug: "team-alpha",
      displayName: undefined,
      awsAccountId: undefined,
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
    // 3 件目は QueryCommand (Deployments GSI1 = TENANT#)
    const deploymentsQuery = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(deploymentsQuery).toBeInstanceOf(QueryCommand);
    expect(deploymentsQuery.input.IndexName).toBe("GSI1");
    expect(deploymentsQuery.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
  });

  it("#1392: should omit teamLoginKey by default (default-deny for read-only TenantViewer)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        name: "イベント A",
        status: "DRAFT",
        teamCount: 1,
        problems: [],
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1", internalSlug: "team-alpha", teamLoginKey: "key-1" }],
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    // Event detail reads never re-expose the one-time bearer credential.
    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out?.teams).toHaveLength(1);
    expect(out?.teams[0]).not.toHaveProperty("teamLoginKey");
    // 他の team メタデータ (internalSlug 等) は引き続き返る。
    expect(out?.teams[0]?.internalSlug).toBe("team-alpha");
    expect(JSON.stringify(out)).not.toContain("key-1");
  });

  it("should merge displayTeamName set by participants in the portal from Deployments", async () => {
    // 統合ギャップの再発防止。participant の PATCH /portal/me は
    // DeploymentsTable のみ書き込む (TeamsTable には書けない) ため、operator 側 read で
    // merge する必要がある。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        name: "イベント A",
        status: "DRAFT",
        teamCount: 2,
        problems: [],
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", internalSlug: "team-1", teamLoginKey: "key-1" },
        { teamId: "T2", internalSlug: "team-2", teamLoginKey: "key-2" },
      ],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        // T1 の 2 deployment 行 (両方とも sample111 で同期済み)
        { teamId: "T1", eventId: "EV1", displayTeamName: "sample111" },
        { teamId: "T1", eventId: "EV1", displayTeamName: "sample111" },
        // T2 は competitor が未ログインで displayTeamName 無し
        { teamId: "T2", eventId: "EV1" },
        // 別 event (= filter で除外されるべき)
        { teamId: "T1", eventId: "EV-OTHER", displayTeamName: "leak-from-other-event" },
      ],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out?.teams).toHaveLength(2);
    const t1 = out?.teams.find((t) => t.teamId === "T1");
    const t2 = out?.teams.find((t) => t.teamId === "T2");
    expect(t1?.displayName).toBe("sample111");
    expect(t2?.displayName).toBeUndefined();
    // 別 event の displayTeamName が混入しないこと
    expect(JSON.stringify(out)).not.toContain("leak-from-other-event");
  });

  it("should return undefined and not leak team results when the Event row is missing", async () => {
    // Get と Query は Promise.all で並列発火するため、Event 不在でも teams query
    // 自体は走る (空 partition なので 1 RCU 程度)。重要なのは結果が caller に返らないこと。
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "LEAKED", internalSlug: "leaked", teamLoginKey: "should-not-leak" }],
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeUndefined();
  });

  it("should return undefined and not leak team results on tenantId mismatch (cross-tenant leak guard)", async () => {
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
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out).toBeUndefined();
  });

  it("should group per-problem jobId / teamId / status from Deployments into deploymentsByProblem", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        name: "イベント A",
        status: "DRAFT",
        teamCount: 2,
        problems: [
          { problemId: "p1", defaultAwsAccountId: "1", defaultRegion: "ap-northeast-1" },
          { problemId: "p2", defaultAwsAccountId: "1", defaultRegion: "ap-northeast-1" },
        ],
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1", internalSlug: "alpha", teamLoginKey: "k1" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", eventId: "EV1", problemId: "p1", jobId: "J1", status: "COMPLETE" },
        { teamId: "T1", eventId: "EV1", problemId: "p1", jobId: "J2", status: "FAILED" },
        { teamId: "T1", eventId: "EV1", problemId: "p2", jobId: "J3", status: "IN_PROGRESS" },
        { teamId: "T1", eventId: "EV1", problemId: "p2", jobId: "J4", status: "AUTO_DELETED" },
        // 別 event の deployment は除外されるべき
        { teamId: "T1", eventId: "EV-OTHER", problemId: "p1", jobId: "J-LEAK", status: "COMPLETE" },
      ],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out?.deploymentsByProblem.p1).toHaveLength(2);
    expect(out?.deploymentsByProblem.p2).toHaveLength(2);
    expect(out?.deploymentsByProblem.p1?.[0]).toMatchObject({
      jobId: "J1",
      teamId: "T1",
      status: "COMPLETE",
    });
    expect(out?.deploymentsByProblem.p2?.[0]).toMatchObject({
      jobId: "J3",
      status: "IN_PROGRESS",
    });
    expect(out?.deploymentsByProblem.p2?.[1]).toMatchObject({
      jobId: "J4",
      status: "AUTO_DELETED",
    });
    // 別 event の jobId が漏れないこと
    expect(JSON.stringify(out?.deploymentsByProblem)).not.toContain("J-LEAK");
  });

  it("Bulk Deploy 未実行 (Deployments 空) なら deploymentsByProblem は空 record", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        name: "イベント A",
        status: "DRAFT",
        teamCount: 1,
        problems: [{ problemId: "p1", defaultAwsAccountId: "1", defaultRegion: "ap-northeast-1" }],
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out?.deploymentsByProblem).toEqual({});
  });

  it("should exclude deployment rows with unknown status values from deploymentsByProblem (defensive)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        problems: [{ problemId: "p1", defaultAwsAccountId: "1", defaultRegion: "ap-northeast-1" }],
        status: "DRAFT",
        teamCount: 1,
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        expiresAt: 9_999_999_999,
      },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", eventId: "EV1", problemId: "p1", jobId: "J1", status: "BOGUS" },
        { teamId: "T1", eventId: "EV1", problemId: "p1", jobId: "J2", status: "COMPLETE" },
      ],
    });

    const out = await getEventDetail(shared, "tenant-acme", "EV1");
    expect(out?.deploymentsByProblem.p1).toHaveLength(1);
    expect(out?.deploymentsByProblem.p1?.[0]?.jobId).toBe("J2");
  });
});
