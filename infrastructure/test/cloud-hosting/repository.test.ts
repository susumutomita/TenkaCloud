import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";

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
  const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
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
  it("creates historical event/team records and a hash-only lookup in one transaction", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(() => Promise.resolve({}));
    expect(await f.repository.createEventWithTeams(f.event, [f.team])).toBe("created");
    const request = f.send.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(TransactWriteCommand);
    if (!(request instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    const writes = request.input.TransactItems ?? [];
    expect(writes).toHaveLength(3);
    expect(writes[0]?.Put?.Item).toMatchObject({
      PK: `EVENT#${f.event.eventId}`,
      SK: "META",
      GSI1PK: "INSTALLATION",
    });
    expect(writes[1]?.Put?.Item).toMatchObject({
      PK: `EVENT#${f.event.eventId}`,
      SK: `TEAM#${f.team.teamId}`,
      authVersion: 1,
    });
    expect(writes[2]?.Put?.Item?.PK).toMatch(/^ACCESS#[a-f0-9]{64}$/u);
    expect(JSON.stringify(writes[2])).not.toContain(f.team.teamLoginKey);
    expect(
      writes.every((write) => write.Put?.ConditionExpression === "attribute_not_exists(PK)"),
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
      f.send.mockRejectedValue(error);
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
    ).rejects.toThrow("1-49");
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
