import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";

import {
  type InstallationScope,
  installationScopeDigest,
} from "../../lib/problem-deploy/control-data/installation-control.js";

const clients: DynamoDBClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});
function fixture() {
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  });
  clients.push(client);
  const doc = DynamoDBDocumentClient.from(client);
  const send = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("Unexpected SDK call in an intercepted test"));
  const repository = new DynamoCloudRepository(doc, {
    events: "events",
    teams: "teams",
    deployments: "deployments",
  });
  const event: EventRecord = {
    eventId: ulid(),
    name: "Fixture",
    status: "DRAFT",
    problems: [{ problemId: "problem-one", defaultRegion: "us-east-1" }],
    teamCount: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    expiresAt: 1_900_000_000,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "team-one",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    expiresAt: event.expiresAt,
  };
  return { repository, send, event, team };
}
function canceled(codes: string[] | undefined) {
  return Object.assign(new Error("Synthetic cancellation"), {
    name: "TransactionCanceledException",
    ...(codes ? { CancellationReasons: codes.map((Code) => ({ Code })) } : {}),
  });
}

describe("DynamoDB repository command/error contract with mocked SDK send", () => {
  it("reads all 48 durable team totals in one strongly consistent event-scoped SCORE query", async () => {
    const f = fixture();
    const scores = Array.from({ length: 48 }, (_, index) => ({
      eventId: f.event.eventId,
      teamId: ulid(),
      score: index,
      completedProblems: 0,
    }));
    f.send.mockImplementationOnce(async () => ({ Items: scores }));
    expect(await f.repository.listTeamScores(f.event.eventId)).toEqual(scores);
    expect(f.send).toHaveBeenCalledTimes(1);
    const command = f.send.mock.calls[0]?.[0];
    if (!(command instanceof QueryCommand)) throw new Error("Expected score query");
    expect(command.input).toEqual({
      TableName: "teams",
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `EVENT#${f.event.eventId}`, ":prefix": "SCORE#" },
    });
  });
  it("creates historical event/team records and a hash-only lookup in one transaction", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.repository.createEventWithTeams(f.event, [f.team])).toBe("created");
    const request = f.send.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(TransactWriteCommand);
    if (!(request instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    const writes = request.input.TransactItems ?? [];
    expect(writes).toHaveLength(4);
    expect(writes[1]?.Put?.Item).toMatchObject({
      PK: `EVENT#${f.event.eventId}`,
      SK: "META",
      GSI1PK: "INSTALLATION",
    });
    expect(writes[2]?.Put?.Item).toMatchObject({
      PK: `EVENT#${f.event.eventId}`,
      SK: `TEAM#${f.team.teamId}`,
      authVersion: 1,
    });
    expect(writes[3]?.Put?.Item?.PK).toMatch(/^ACCESS#[a-f0-9]{64}$/u);
    expect(JSON.stringify(writes[3])).not.toContain(f.team.teamLoginKey);
    expect(
      writes
        .slice(1)
        .every((write) => write.Put?.ConditionExpression === "attribute_not_exists(PK)"),
    ).toBe(true);
  });
  it.each([
    canceled(["None", "ConditionalCheckFailed"]),
    canceled(["TransactionConflict"]),
    Object.assign(new Error("race"), { name: "TransactionConflictException" }),
  ])(
    "returns conflicts only for definitive transaction concurrency failures: %s",
    async (error) => {
      const f = fixture();
      f.send.mockRejectedValueOnce(error).mockImplementationOnce(async () => ({}));
      expect(await f.repository.createEventWithTeams(f.event, [f.team])).toBe("conflict");
    },
  );
  it.each([
    new Error("AccessDeniedException"),
    canceled(["ProvisionedThroughputExceeded"]),
    canceled(["ConditionalCheckFailed", "ValidationError"]),
    canceled(undefined),
    canceled([]),
  ])(
    "propagates infrastructure failures instead of returning success/conflict: %s",
    async (error) => {
      const f = fixture();
      f.send.mockRejectedValue(error);
      await expect(f.repository.createEventWithTeams(f.event, [f.team])).rejects.toBe(error);
    },
  );
  it("rejects cross-event teams, duplicates and oversized atomic writes before calling DynamoDB", async () => {
    const f = fixture();
    await expect(
      f.repository.createEventWithTeams(f.event, [{ ...f.team, eventId: ulid() }]),
    ).rejects.toThrow();
    await expect(
      f.repository.createEventWithTeams({ ...f.event, teamCount: 2 }, [f.team, f.team]),
    ).rejects.toThrow();
    await expect(
      f.repository.createEventWithTeams(
        { ...f.event, teamCount: 50 },
        Array.from({ length: 50 }, () => ({ ...f.team, teamId: ulid() })),
      ),
    ).rejects.toThrow("1-48");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("uses strongly consistent point reads and rejects a malformed stored event scope", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve({ Item: f.event }));
    expect(await f.repository.getEvent(f.event.eventId)).toEqual(f.event);
    const request = f.send.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(GetCommand);
    if (!(request instanceof GetCommand)) throw new Error("Expected get");
    expect(request.input.ConsistentRead).toBe(true);
    f.send.mockImplementationOnce(() => Promise.resolve({ Item: { ...f.event, eventId: ulid() } }));
    await expect(f.repository.getEvent(f.event.eventId)).rejects.toThrow("scope mismatch");
  });
  it("rejects malformed or absent participant credentials without fallback", async () => {
    const f = fixture();
    expect(await f.repository.authenticateTeam("not-a-team-key", 0)).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.repository.authenticateTeam(f.team.teamLoginKey, 0)).toBeUndefined();
    f.send.mockImplementationOnce(() =>
      Promise.resolve({ Item: { eventId: "bad", teamId: f.team.teamId, authVersion: 1 } }),
    );
    await expect(f.repository.authenticateTeam(f.team.teamLoginKey, 0)).rejects.toThrow();
  });
  it.each([
    { accessRevoked: true },
    { authVersion: 2 },
    { teamLoginKey: "B".repeat(43) },
    { expiresAt: 1 },
  ])("does not authenticate stale/revoked/expired metadata: %s", async (change) => {
    const f = fixture();
    f.send
      .mockImplementationOnce(() =>
        Promise.resolve({
          Item: { eventId: f.team.eventId, teamId: f.team.teamId, authVersion: 1 },
        }),
      )
      .mockImplementationOnce(() => Promise.resolve({ Item: { ...f.team, ...change } }));
    expect(
      await f.repository.authenticateTeam(f.team.teamLoginKey, 1_700_000_000_000),
    ).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(["ARCHIVED", "TEARDOWN"])(
    "refuses authentication when the event is %s",
    async (status) => {
      const f = fixture();
      f.send
        .mockImplementationOnce(() =>
          Promise.resolve({
            Item: { eventId: f.team.eventId, teamId: f.team.teamId, authVersion: 1 },
          }),
        )
        .mockImplementationOnce(() => Promise.resolve({ Item: f.team }))
        .mockImplementationOnce(() => Promise.resolve({ Item: { ...f.event, status } }));
      expect(
        await f.repository.authenticateTeam(f.team.teamLoginKey, 1_700_000_000_000),
      ).toBeUndefined();
    },
  );
  it("rotates lookup and metadata together under an auth-version condition", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.repository.rotateTeamAccess(f.team, "B".repeat(43), f.event.createdAt)).toBe(
      "updated",
    );
    const request = f.send.mock.calls[0]?.[0];
    if (!(request instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    expect(request.input.TransactItems).toHaveLength(3);
    expect(request.input.TransactItems?.[0]?.Put).toMatchObject({
      ConditionExpression: "authVersion = :version",
      ExpressionAttributeValues: { ":version": 1 },
      Item: { authVersion: 2, accessRevoked: false },
    });
    expect(request.input.TransactItems?.[1]?.Delete?.Key?.PK).toMatch(/^ACCESS#/u);
    await expect(
      f.repository.rotateTeamAccess(f.team, f.team.teamLoginKey, f.event.createdAt),
    ).rejects.toThrow("must be new");
  });
  it("drains all query pages within the event partition", async () => {
    const f = fixture();
    const second = { ...f.team, teamId: ulid(), internalSlug: "team-two" };
    f.send
      .mockImplementationOnce(() =>
        Promise.resolve({
          Items: [f.team],
          LastEvaluatedKey: { PK: `EVENT#${f.event.eventId}`, SK: `TEAM#${f.team.teamId}` },
        }),
      )
      .mockImplementationOnce(() => Promise.resolve({ Items: [second] }));
    expect(await f.repository.listTeamsByEvent(f.event.eventId)).toEqual([f.team, second]);
    expect(f.send).toHaveBeenCalledTimes(2);
    const next = f.send.mock.calls[1]?.[0];
    if (!(next instanceof QueryCommand)) throw new Error("Expected query");
    expect(next.input.ConsistentRead).toBe(true);
    expect(next.input.ExclusiveStartKey?.PK).toBe(`EVENT#${f.event.eventId}`);
  });
  it("rejects a stored team record from a different event", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve({ Item: { ...f.team, eventId: ulid() } }));
    await expect(f.repository.getTeam(f.team.eventId, f.team.teamId)).rejects.toThrow(
      "scope mismatch",
    );
  });
});

describe("durable installation intake fence", () => {
  const scope: InstallationScope = {
    account: "123456789012",
    region: "us-east-1",
    environment: "development",
    applicationStackId:
      "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud/app-id",
    backendStackId:
      "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy/backend-id",
  };
  const at = "2026-10-01T10:00:00.000Z";
  const control = {
    scope,
    scopeDigest: installationScopeDigest(scope),
    status: "DRAINING",
    startedAt: at,
    updatedAt: at,
  };
  it("atomically stops an empty installation and reuses its scope on restart", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => ({}));
    expect(await f.repository.stopAcceptingInstallation(scope, at)).toEqual(control);
    const read = f.send.mock.calls[0]?.[0];
    if (!(read instanceof GetCommand)) throw new Error("Expected strong read");
    expect(read.input).toMatchObject({
      TableName: "events",
      ConsistentRead: true,
      Key: { PK: "INSTALLATION", SK: "CONTROL" },
    });
    const command = f.send.mock.calls[1]?.[0];
    if (!(command instanceof TransactWriteCommand)) throw new Error("Expected atomic stop");
    expect(command.input.TransactItems?.[0]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK)",
      Item: control,
    });
    f.send.mockImplementationOnce(async () => ({ Item: control }));
    expect(await f.repository.stopAcceptingInstallation(scope, "2026-10-01T11:00:00.000Z")).toEqual(
      control,
    );
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  it("recovers the winning stop after a race and propagates uncertain failures", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(canceled(["ConditionalCheckFailed"]))
      .mockImplementationOnce(async () => ({ Item: control }));
    expect(await f.repository.stopAcceptingInstallation(scope, at)).toEqual(control);
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(f.repository.stopAcceptingInstallation(scope, at)).rejects.toThrow("AccessDenied");
  });
  it("never adopts a different installation, malformed scope, or corrupt digest", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({ Item: control }));
    await expect(
      f.repository.stopAcceptingInstallation(
        {
          ...scope,
          applicationStackId: scope.applicationStackId.replace("app-id", "replacement-id"),
        },
        at,
      ),
    ).rejects.toThrow("scope_changed");
    await expect(
      f.repository.stopAcceptingInstallation({ ...scope, account: "210987654321" }, at),
    ).rejects.toThrow();
    f.send.mockImplementationOnce(async () => ({
      Item: { ...control, scopeDigest: "a".repeat(64) },
    }));
    await expect(f.repository.installationControl()).rejects.toThrow("scope_corrupt");
  });
  it("reports an intake stop instead of an ordinary event creation collision", async () => {
    const f = fixture();
    f.send
      .mockRejectedValueOnce(canceled(["ConditionalCheckFailed"]))
      .mockImplementationOnce(async () => ({ Item: control }));
    await expect(f.repository.createEventWithTeams(f.event, [f.team])).rejects.toThrow(
      "installation_draining",
    );
  });
  it("requires the fence before strongly scanning every base-table page", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({}));
    await expect(f.repository.listStoppedInstallationEvents(scope)).rejects.toThrow("not_stopped");
    const cursor = { PK: "OTHER", SK: "META" };
    f.send
      .mockImplementationOnce(async () => ({ Item: control }))
      .mockImplementationOnce(async () => ({ Items: [], LastEvaluatedKey: cursor }))
      .mockImplementationOnce(async () => ({
        Items: [{ ...f.event, PK: `EVENT#${f.event.eventId}`, SK: "META" }],
      }));
    expect(await f.repository.listStoppedInstallationEvents(scope)).toEqual([f.event]);
    for (const [command] of f.send.mock.calls.slice(2)) {
      if (!(command instanceof ScanCommand)) throw new Error("Expected base-table scan");
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input).not.toHaveProperty("IndexName");
    }
    const next = f.send.mock.calls[3]?.[0];
    if (!(next instanceof ScanCommand)) throw new Error("Expected second page");
    expect(next.input.ExclusiveStartKey).toEqual(cursor);
  });
  it.each([
    { status: "TEARDOWN", teardownExpected: 1, teardownCompleted: 1 },
    { status: "ARCHIVED", teardownExpected: 2, teardownCompleted: 1 },
    { status: "ARCHIVED" },
  ])("does not call an incomplete event drained: %s", async (change) => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: control }))
      .mockImplementationOnce(async () => ({
        Items: [{ ...f.event, ...change, PK: `EVENT#${f.event.eventId}`, SK: "META" }],
      }));
    await expect(f.repository.confirmInstallationDrained(scope, at)).rejects.toThrow(
      "events_not_drained",
    );
    expect(f.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
  });
  it("marks verified completion with a scope CAS and keeps the fence after a replay", async () => {
    const f = fixture();
    const rows = {
      Items: [
        {
          ...f.event,
          status: "ARCHIVED",
          teardownExpected: 0,
          teardownCompleted: 0,
          PK: `EVENT#${f.event.eventId}`,
          SK: "META",
        },
      ],
    };
    f.send
      .mockImplementationOnce(async () => ({ Item: control }))
      .mockImplementationOnce(async () => rows)
      .mockImplementationOnce(async () => ({ Item: control }))
      .mockImplementationOnce(async () => ({}));
    await f.repository.confirmInstallationDrained(scope, at);
    const last = f.send.mock.calls.at(-1)?.[0];
    if (!(last instanceof TransactWriteCommand)) throw new Error("Expected atomic completion");
    expect(last.input.TransactItems?.[0]?.Update).toMatchObject({
      ConditionExpression: "scopeDigest = :scope AND #status = :closing",
      ExpressionAttributeValues: { ":closing": "DRAINING", ":drained": "DRAINED" },
    });
    f.send
      .mockImplementationOnce(async () => ({ Item: { ...control, status: "DRAINED" } }))
      .mockImplementationOnce(async () => rows)
      .mockImplementationOnce(async () => ({ Item: { ...control, status: "DRAINED" } }));
    await f.repository.confirmInstallationDrained(scope, at);
    f.send.mockImplementationOnce(async () => ({ Item: { ...control, status: "DRAINED" } }));
    await expect(f.repository.assertAcceptingInstallation()).rejects.toThrow(
      "installation_draining",
    );
  });
});
