import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * Issue #1418: event-handler/list.ts (listEvents + getEventDetail + 集約 helper) は 60% branch
 * だった。 toSummary の field default 群、 cursor encode/decode、 limit clamp、 getEventDetail の
 * not-found / tenant-mismatch / displayName precedence / login-key expansion / withScoreEvents、
 * deployment 集約の guard 群を pin する。
 *
 * collectTeamScoreEvents は mock (= withScoreEvents 経路の marker)。 DDB は command 種別 +
 * TableName で出し分ける fake。
 */
const mocks = vi.hoisted(() => ({ collectTeamScoreEvents: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/team-score-events", () => ({
  collectTeamScoreEvents: mocks.collectTeamScoreEvents,
}));

const { listEvents, getEventDetail } = await import(
  "../../lib/problem-deploy/handlers/event-handler/list"
);
const { makeTestControlDataRuntime } = await import("./control-data/runtime.test-helpers");

const cfg = {
  listItems: [] as Record<string, unknown>[] | undefined,
  listLastKey: undefined as Record<string, unknown> | undefined,
  eventItem: undefined as Record<string, unknown> | undefined,
  teamItems: [] as Record<string, unknown>[] | undefined,
  deployItems: [] as Record<string, unknown>[] | undefined,
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command + TableName.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof GetCommand) return { Item: cfg.eventItem };
    const t = cmd.input.TableName as string;
    if (t === "Events") return { Items: cfg.listItems, LastEvaluatedKey: cfg.listLastKey };
    if (t === "Teams") return { Items: cfg.teamItems };
    if (t === "Deployments") return { Items: cfg.deployItems };
    return {};
  }),
};
const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb,
  eventsTableName: "Events",
  teamsTableName: "Teams",
  deploymentsTableName: "Deployments",
} as unknown as EventSharedResources;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.listItems = [];
  cfg.listLastKey = undefined;
  cfg.eventItem = undefined;
  cfg.teamItems = [];
  cfg.deployItems = [];
  mocks.collectTeamScoreEvents.mockResolvedValue({ "team-1": [{ at: "t", cumulative: 10 }] });
});

describe("listEvents", () => {
  it("should map full event items and emit a nextCursor when paginated", async () => {
    cfg.listItems = [
      {
        eventId: "e1",
        name: "Cup",
        status: "RUNNING",
        teamCount: 3,
        problems: [{}, {}],
        createdAt: "c",
        updatedAt: "u",
        expiresAt: 99,
        startsAt: "2026-06-01T00:00:00Z",
        endsAt: "2026-06-02T00:00:00Z",
        deployAt: "2026-05-31T00:00:00Z",
        teardownAt: "2026-06-03T00:00:00Z",
        scoringLocked: true,
        scoringLockedAt: "2026-06-01T12:00:00Z",
        scoreboardFreezeMinutes: 10,
      },
    ];
    cfg.listLastKey = { PK: "EVENT#e1" };
    const res = await listEvents(shared, { tenantId: "t1" });
    expect(res.items[0]).toMatchObject({
      eventId: "e1",
      problemCount: 2,
      scoringLocked: true,
      scoreboardFreezeMinutes: 10,
      // 自動デプロイ/撤去の予定時刻を summary が落とすと UI が常に「未設定」になる回帰ガード。
      deployAt: "2026-05-31T00:00:00Z",
      teardownAt: "2026-06-03T00:00:00Z",
    });
    expect(res.nextCursor).toBeTypeOf("string");
  });

  it("should apply field defaults for a minimal item and omit nextCursor when not paginated", async () => {
    cfg.listItems = [{}]; // every field absent → defaults + undefined optionals
    const res = await listEvents(shared, { tenantId: "t1", limit: 5 });
    expect(res.items[0]).toMatchObject({
      eventId: "",
      name: "",
      status: "DRAFT",
      teamCount: 0,
      problemCount: 0,
      expiresAt: 0,
    });
    expect(res.items[0].startsAt).toBeUndefined();
    expect(res.items[0].scoringLocked).toBeUndefined();
    expect(res.nextCursor).toBeUndefined();
  });

  it("should decode a valid cursor and pass it as ExclusiveStartKey", async () => {
    const cursor = Buffer.from(JSON.stringify({ PK: "EVENT#e0" }), "utf8").toString("base64url");
    await listEvents(shared, { tenantId: "t1", cursor });
    expect(ddb.send.mock.calls[0][0].input.ExclusiveStartKey).toEqual({ PK: "EVENT#e0" });
  });

  it("should ignore a malformed cursor (start from the beginning)", async () => {
    await listEvents(shared, { tenantId: "t1", cursor: "%%%not-base64-json%%%" });
    expect(ddb.send.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  });

  it("should ignore a cursor that decodes to a non-object", async () => {
    const cursor = Buffer.from("[1,2,3]", "utf8").toString("base64url");
    await listEvents(shared, { tenantId: "t1", cursor });
    expect(ddb.send.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  });

  it("should clamp the limit to MAX and to a floor of 1", async () => {
    await listEvents(shared, { tenantId: "t1", limit: 999999 });
    expect(ddb.send.mock.calls[0][0].input.Limit).toBe(200);
    ddb.send.mockClear();
    await listEvents(shared, { tenantId: "t1", limit: 0 });
    expect(ddb.send.mock.calls[0][0].input.Limit).toBe(1);
  });

  it("should default to [] when the query returns no Items", async () => {
    cfg.listItems = undefined; // out.Items undefined → ?? [] path
    expect((await listEvents(shared, { tenantId: "t1" })).items).toEqual([]);
  });
});

describe("getEventDetail", () => {
  const eventBase = { eventId: "e1", name: "Cup", tenantId: "t1", problems: [{ problemId: "p" }] };

  it("should return undefined when the event is not found", async () => {
    cfg.eventItem = undefined;
    expect(await getEventDetail(shared, "t1", "e1")).toBeUndefined();
  });

  it("should return undefined on a tenant mismatch", async () => {
    cfg.eventItem = { ...eventBase, tenantId: "other-tenant" };
    expect(await getEventDetail(shared, "t1", "e1")).toBeUndefined();
  });

  it("should build teams with displayName precedence + login-key gating + score events", async () => {
    cfg.eventItem = { ...eventBase };
    cfg.teamItems = [
      {
        teamId: "team-1",
        internalSlug: "a",
        displayName: "FromTeams",
        teamLoginKey: "key-1",
        awsAccountId: "123456789012",
      },
      { teamId: "team-2", internalSlug: "b" },
      { teamId: "team-3" }, // no internalSlug → String(undefined ?? "") = ""
      { internalSlug: "ghost" }, // no teamId → String(undefined ?? "") = ""
    ];
    cfg.deployItems = [
      // valid deployment for team-1 → displayName (precedence over TeamsTable), ref, summary
      {
        eventId: "e1",
        PK: "DEP#1",
        teamId: "team-1",
        displayTeamName: "FromPortal",
        teamName: "TN",
        problemId: "p",
        jobId: "01J",
        status: "COMPLETE",
      },
      { eventId: "other", teamId: "team-1", problemId: "p", jobId: "x", status: "COMPLETE" }, // wrong event → skipped
      {
        eventId: "e1",
        teamId: "team-1",
        displayTeamName: "",
        problemId: "p",
        jobId: "02J",
        status: "PENDING",
      }, // empty displayName → no capture; no PK → no ref
      {
        eventId: "e1",
        PK: "DEP#3",
        teamId: "team-1",
        problemId: "p",
        jobId: "03J",
        status: "WEIRD",
      }, // invalid status → no summary
      { eventId: "e1", PK: "DEP#4", teamId: 999, problemId: "p", jobId: "04J", status: "COMPLETE" }, // teamId not string → guards skip
      { eventId: "e1", PK: "DEP#6", teamId: "team-1", problemId: "p", jobId: "06J", status: 42 }, // status not string → parseDeploymentStatus returns undefined
      {
        eventId: "e1",
        PK: "DEP#7",
        teamId: "team-1",
        problemId: "p",
        jobId: 7,
        status: "COMPLETE",
      }, // jobId not string → summary guard skip
      {
        eventId: "e1",
        PK: "DEP#8",
        teamId: "team-1",
        problemId: 8,
        jobId: "08J",
        status: "COMPLETE",
      }, // problemId not string → summary guard skip
    ];
    const detail = await getEventDetail(shared, "t1", "e1", {
      withScoreEvents: true,
    });
    expect(detail?.teams[0]).toMatchObject({
      teamId: "team-1",
      displayName: "FromPortal", // Deployments overrides TeamsTable
      awsAccountId: "123456789012",
    });
    expect(detail?.teams[0]).not.toHaveProperty("teamLoginKey");
    // team-2: no portal name, no TeamsTable displayName → undefined; no login key field
    expect(detail?.teams[1].displayName).toBeUndefined();
    expect(detail?.teams[1]).not.toHaveProperty("teamLoginKey");
    expect(detail?.deploymentsByProblem.p.map((d) => d.jobId)).toEqual(["01J", "02J"]);
    expect(detail?.scoreEventsByTeam).toBeDefined();
    expect(mocks.collectTeamScoreEvents).toHaveBeenCalledTimes(1);
  });

  it("should withhold login keys and omit score events by default", async () => {
    cfg.eventItem = { ...eventBase };
    cfg.teamItems = [
      { teamId: "team-1", internalSlug: "a", displayName: "X", teamLoginKey: "key-1" },
    ];
    const detail = await getEventDetail(shared, "t1", "e1");
    expect(detail?.teams[0]).not.toHaveProperty("teamLoginKey");
    expect(detail?.teams[0].displayName).toBe("X"); // TeamsTable fallback (no deployment)
    expect(detail?.scoreEventsByTeam).toBeUndefined();
    expect(mocks.collectTeamScoreEvents).not.toHaveBeenCalled();
  });

  it("should include stored login keys only when the caller explicitly opts in", async () => {
    cfg.eventItem = { ...eventBase };
    cfg.teamItems = [
      { teamId: "team-1", internalSlug: "a", teamLoginKey: "key-1" },
      { teamId: "team-2", internalSlug: "b" },
    ];

    const detail = await getEventDetail(shared, "t1", "e1", {
      withTeamLoginKeys: true,
    });

    expect(detail?.teams[0]).toHaveProperty("teamLoginKey", "key-1");
    expect(detail?.teams[1]).not.toHaveProperty("teamLoginKey");
  });

  it("should default problems to [] when the event has a non-array problems field", async () => {
    cfg.eventItem = { ...eventBase, problems: "not-an-array" };
    const detail = await getEventDetail(shared, "t1", "e1");
    expect(detail?.problems).toEqual([]);
  });

  it("should project schedule fields (deployAt/teardownAt) onto the detail", async () => {
    cfg.eventItem = {
      ...eventBase,
      deployAt: "2026-05-31T00:00:00Z",
      teardownAt: "2026-06-03T00:00:00Z",
    };
    const detail = await getEventDetail(shared, "t1", "e1");
    expect(detail?.deployAt).toBe("2026-05-31T00:00:00Z");
    expect(detail?.teardownAt).toBe("2026-06-03T00:00:00Z");
  });

  it("should default teams/deployments to [] when those queries return no Items", async () => {
    cfg.eventItem = { ...eventBase };
    cfg.teamItems = undefined; // teamsOut.Items undefined → ?? []
    cfg.deployItems = undefined; // deploymentsOut.Items undefined → ?? []
    const detail = await getEventDetail(shared, "t1", "e1");
    expect(detail?.teams).toEqual([]);
    expect(detail?.deploymentsByProblem).toEqual({});
  });
});
