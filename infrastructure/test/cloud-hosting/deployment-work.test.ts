import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreationReservation,
  contentDigest,
  type DeploymentIdentity,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
  flagMatchesDigest,
  scoringBlock,
  type TeardownRecord,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";

const NOW = Date.parse("2026-10-01T09:00:00.000Z");
const AT = new Date(NOW).toISOString();
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
  const document = DynamoDBDocumentClient.from(client);
  const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
  const tables = { events: "events", teams: "teams", deployments: "deployments" };
  const work = new DynamoDeploymentWork(document, tables);
  const repository = new DynamoCloudRepository(document, tables);
  const event: EventRecord = {
    eventId: ulid(),
    name: "Synthetic",
    status: "READY",
    teamCount: 1,
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    startsAt: AT,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: NOW / 1000 + 86400,
  };
  const team: TeamRecord = {
    eventId: event.eventId,
    teamId: ulid(),
    internalSlug: "one",
    teamLoginKey: "A".repeat(43),
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  const job: DeploymentJob = {
    jobId: ulid(),
    eventId: event.eventId,
    teamId: team.teamId,
    problemId: "hello-world",
    region: "us-east-1",
    awsAccountId: "123456789012",
    status: "PENDING",
    expiresAt: event.expiresAt,
    score: 0,
    attempt: 1,
    revision: 0,
    createdAt: AT,
    updatedAt: AT,
    stackName: deploymentStackName(event.eventId, team.teamId, "hello-world"),
    problemDir: "problems/challenges/hello-world",
    artifactDigest: contentDigest("synthetic-template"),
    connection: {
      eventId: event.eventId,
      teamId: team.teamId,
      accountId: "123456789012",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/Fixture",
      externalIdParameter: "arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/fixture",
      version: 1,
      verifiedAt: AT,
    },
    scoring: { kind: "flag", points: 100, flagOutputKey: "PrivateFlag", wrongPenalty: 5 },
  };
  const accept = {
    event,
    team,
    job,
    requestKey: "deploy-1",
    requestHash: contentDigest("request"),
    now: NOW,
  };
  const flag = {
    event,
    team,
    jobId: job.jobId,
    attempt: 1,
    requestKey: "submission-1",
    flag: "correct",
    now: NOW,
  };
  return { work, repository, send, event, team, job, accept, flag };
}
function transaction(value: unknown) {
  if (!(value instanceof TransactWriteCommand)) throw new Error("Expected transaction");
  return value.input.TransactItems ?? [];
}

describe("deployment transaction shape with intercepted SDK only; actual Dynamo acceptance is separate", () => {
  it("atomically persists guarded job, target, pending dispatch, independent score row and acceptance receipt", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({}));
    expect(await f.work.accept(f.accept)).toEqual({
      kind: "accepted",
      jobId: f.job.jobId,
      attempt: 1,
    });
    const writes = transaction(f.send.mock.calls[1]?.[0]);
    expect(writes).toHaveLength(9);
    expect(writes.filter((write) => write.ConditionCheck)).toHaveLength(3);
    expect(writes.some((write) => write.Put?.Item?.PK === "DISPATCH#PENDING")).toBe(true);
    expect(writes.some((write) => write.Update?.Key?.SK === `SCORE#${f.team.teamId}`)).toBe(true);
    expect(writes.some((write) => write.Update?.Key?.SK === `TEAM#${f.team.teamId}`)).toBe(false);
    const proof = writes.find((write) => write.Put?.Item?.SK === "CREATE#1")?.Put;
    expect(proof?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(proof?.Item).toEqual({
      PK: `DEPLOYMENT#${f.job.jobId}`,
      SK: "CREATE#1",
      eventId: f.event.eventId,
      teamId: f.team.teamId,
      jobId: f.job.jobId,
      attempt: 1,
      state: "NOT_STARTED",
      leaseUntil: 0,
    });
  });
  it("keeps event creation plus 49 teams and replay receipt inside the real 100-item limit", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({}));
    const teams = Array.from({ length: 49 }, (_, index) => ({
      ...f.team,
      teamId: ulid(),
      internalSlug: `team-${index}`,
      teamLoginKey: `${index}`.padStart(43, "A"),
    }));
    await f.repository.createEventWithTeams({ ...f.event, teamCount: 49 }, teams, {
      scope: "organizer",
      key: "creation",
      requestHash: "hash",
      response: { eventId: f.event.eventId },
    });
    expect(transaction(f.send.mock.calls[0]?.[0])).toHaveLength(100);
  });
  it("replays the saved acceptance without creating another job and rejects a changed body", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({
      Item: { requestHash: f.accept.requestHash, response: { jobId: f.job.jobId, attempt: 1 } },
    }));
    expect((await f.work.accept(f.accept)).kind).toBe("replay");
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(f.work.accept({ ...f.accept, requestHash: "different" })).rejects.toThrow(
      "idempotency_key_reused",
    );
  });
  it.each(["event", "team", "connection", "problem", "stack", "attempt", "score", "expiry"])(
    "rejects %s drift before writing",
    async (field) => {
      const f = fixture();
      const changes = {
        event: { eventId: ulid() },
        team: { teamId: ulid() },
        connection: { connection: { ...f.job.connection, teamId: ulid() } },
        problem: { problemId: "other" },
        stack: { stackName: `tc-cloud-${"b".repeat(40)}` },
        attempt: { attempt: 2 },
        score: { score: 1 },
        expiry: { expiresAt: f.event.expiresAt + 1 },
      };
      await expect(
        f.work.accept({
          ...f.accept,
          job: { ...f.job, ...changes[field as keyof typeof changes] },
        }),
      ).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("does not swallow infrastructure/uncertain failures as accepted work", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(f.work.accept(f.accept)).rejects.toThrow("AccessDenied");
  });
  it("claims the current attempt and removes dispatch intent in one guarded commit", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.begin(f.job, "owner", AT)).toBe("started");
    const writes = transaction(f.send.mock.calls[1]?.[0]);
    expect(writes[0]?.Update?.ConditionExpression).toContain("attempt = :attempt");
    expect(writes[0]?.Update?.ConditionExpression).toContain("#status = :pending");
    expect(writes[1]?.Delete?.Key?.PK).toBe("DISPATCH#PENDING");
  });
  it("rejects stale ownership and attempt before completion", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({
      Item: { ...f.job, status: "IN_PROGRESS", owner: "current" },
    }));
    await expect(
      f.work.finish(f.job, "other", { status: "FAILED", failureReason: "synthetic" }, AT),
    ).rejects.toThrow("owner_changed");
    await expect(f.work.begin({ ...f.job, attempt: 2 }, "other", AT)).rejects.toThrow(
      "attempt_changed",
    );
  });
  it("does not count a ready deployment as a solved problem", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, status: "IN_PROGRESS", owner: "owner" },
      }))
      .mockImplementationOnce(async () => ({}));
    expect(
      await f.work.finish(
        f.job,
        "owner",
        {
          status: "COMPLETE",
          stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${f.job.stackName}/id`,
          flagDigest: flagDigest("correct"),
        },
        AT,
      ),
    ).toBe("updated");
    const writes = transaction(f.send.mock.calls[1]?.[0]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.Update?.ExpressionAttributeValues?.[":status"]).toBe("COMPLETE");
    expect(writes.some((write) => write.Update?.TableName === "teams")).toBe(false);
  });
  it("does not allow the verifier answer to appear in public outputs", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({
      Item: { ...f.job, status: "IN_PROGRESS", owner: "owner" },
    }));
    await expect(
      f.work.finish(
        f.job,
        "owner",
        {
          status: "COMPLETE",
          stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${f.job.stackName}/id`,
          flagDigest: flagDigest("correct"),
          publicOutputs: { PrivateFlag: "correct" },
        },
        AT,
      ),
    ).rejects.toThrow();
  });
  it("places score, history, receipt, projection and live event/team checks in one transaction", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, status: "COMPLETE", flagDigest: flagDigest("correct") },
      }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.submitFlag(f.flag)).toEqual({
      kind: "ok",
      scoreDelta: 100,
      totalScore: 100,
    });
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes).toHaveLength(6);
    expect(writes[0]?.ConditionCheck?.ConditionExpression).toContain("startsAt <= :iso");
    expect(writes[1]?.ConditionCheck?.ConditionExpression).toContain("authVersion = :version");
    expect(writes[2]?.Update?.ConditionExpression).toContain(
      "revision = :revision AND attempt = :attempt",
    );
    expect(writes[3]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(writes[4]?.Put?.Item?.points).toBe(100);
    expect(writes[5]?.Update?.Key?.SK).toBe(`SCORE#${f.team.teamId}`);
    expect(writes[5]?.Update?.UpdateExpression).toBe("ADD score :delta, completedProblems :solved");
    expect(writes[5]?.Update?.ExpressionAttributeValues?.[":solved"]).toBe(1);
  });
  it("distinguishes intentional wrong resubmission from network replay", async () => {
    const f = fixture();
    const wrong = { ...f.flag, flag: "wrong" };
    for (const [index, score] of [30, 25].entries()) {
      f.send
        .mockImplementationOnce(async () => ({
          Item: { ...f.job, score, status: "COMPLETE", flagDigest: flagDigest("correct") },
        }))
        .mockImplementationOnce(async () => ({}))
        .mockImplementationOnce(async () => ({}));
      expect(await f.work.submitFlag({ ...wrong, requestKey: `intent-${index}` })).toEqual({
        kind: "wrong",
        scoreDelta: -5,
        totalScore: score - 5,
      });
      const writes = transaction(f.send.mock.calls.at(-1)?.[0]);
      expect(writes[5]?.Update?.ExpressionAttributeValues?.[":solved"]).toBe(0);
    }
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, score: 20, status: "COMPLETE", flagDigest: flagDigest("correct") },
      }))
      .mockImplementationOnce(async () => ({
        Item: {
          requestHash: contentDigest(JSON.stringify([f.job.jobId, 1, "wrong"])),
          response: { kind: "wrong", scoreDelta: -5, totalScore: 25 },
        },
      }))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.submitFlag({ ...wrong, requestKey: "intent-0" })).toEqual({
      kind: "wrong",
      scoreDelta: -5,
      totalScore: 25,
    });
    expect(transaction(f.send.mock.calls.at(-1)?.[0]).every((write) => write.ConditionCheck)).toBe(
      true,
    );
  });
  it("queries only one team's historical GSI prefix and independent score projections", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({ Items: [] }));
    await f.repository.listDeploymentsByTeam(f.event.eventId, f.team.teamId);
    const query = f.send.mock.calls[0]?.[0];
    if (!(query instanceof QueryCommand)) throw new Error("Expected query");
    expect(query.input.KeyConditionExpression).toContain("begins_with(GSI1SK, :team)");
    expect(query.input.ExpressionAttributeValues?.[":team"]).toBe(`TEAM#${f.team.teamId}#PROBLEM#`);
    await f.repository.listTeamScores(f.event.eventId);
    const scores = f.send.mock.calls[1]?.[0];
    if (!(scores instanceof QueryCommand)) throw new Error("Expected score query");
    expect(scores.input.ConsistentRead).toBe(true);
    expect(scores.input.ExpressionAttributeValues?.[":prefix"]).toBe("SCORE#");
  });
});
describe("historical flag verification and event gates", () => {
  it("compares trimmed case-sensitive digests without exposing the expected value", () => {
    expect(flagMatchesDigest(" correct ", flagDigest("correct"))).toBe(true);
    expect(flagMatchesDigest("Correct", flagDigest("correct"))).toBe(false);
    expect(() => flagMatchesDigest("correct", "bad")).toThrow();
  });
  it.each([
    [{ startsAt: undefined }, "scoring_not_started"],
    [{ startsAt: "bad" }, "scoring_not_started"],
    [{ startsAt: new Date(NOW + 1).toISOString() }, "scoring_not_started"],
    [{ status: "ENDED" }, "scoring_ended"],
    [{ endsAt: "bad" }, "scoring_ended"],
    [{ endsAt: AT }, "scoring_ended"],
    [{ scoringLocked: true }, "scoring_locked"],
  ] as const)("fails closed for %s", (changes, expected) => {
    const f = fixture();
    expect(scoringBlock({ ...f.event, ...changes }, NOW)).toBe(expected);
  });
});

function conditionalFailure() {
  return Object.assign(new Error("Synthetic CAS conflict"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}
describe("durable work recovery with intercepted SDK responses", () => {
  it("conditionally changes only requested schedule fields and rejects a stale event revision", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({}));
    await f.work.setSchedule(f.event, { startsAt: AT, endsAt: undefined, scoringLocked: true }, AT);
    const update = transaction(f.send.mock.calls[0]?.[0])[0]?.Update;
    expect(update?.UpdateExpression).toContain("scoringLocked = :scoringLocked");
    expect(update?.UpdateExpression).not.toContain("endsAt");
    expect(update?.ConditionExpression).toContain("updatedAt = :previous");
    f.send.mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.setSchedule(f.event, { scoringLocked: false }, AT)).rejects.toThrow(
      "event_schedule_changed",
    );
  });
  it("recovers the immutable winning batch reservation after a concurrent writer", async () => {
    const f = fixture();
    const proposal = { targets: ["synthetic"] };
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({ Item: { requestHash: "same", response: proposal } }));
    expect(await f.work.pinRequest(f.event.eventId, "operation", "same", {})).toEqual(proposal);
    f.send.mockImplementationOnce(async () => ({
      Item: { requestHash: "same", response: proposal },
    }));
    expect(await f.work.pinRequest(f.event.eventId, "operation", "same", {})).toEqual(proposal);
    f.send.mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => ({}));
    expect(await f.work.pinRequest(f.event.eventId, "new", "new", proposal)).toEqual(proposal);
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({}));
    await expect(f.work.pinRequest(f.event.eventId, "lost", "same", proposal)).rejects.toThrow(
      "batch_reservation_conflict",
    );
    await expect(
      f.work.pinRequest(f.event.eventId, "big", "same", "x".repeat(131073)),
    ).rejects.toThrow("bounds");
  });
  it("strongly reads the target and rejects corrupt target-to-job ownership", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).toBeUndefined();
    f.send
      .mockImplementationOnce(async () => ({ Item: { jobId: f.job.jobId } }))
      .mockImplementationOnce(async () => ({ Item: f.job }));
    expect(await f.work.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).toEqual(f.job);
    f.send
      .mockImplementationOnce(async () => ({ Item: { jobId: f.job.jobId } }))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, teamId: ulid() } }));
    await expect(f.work.getTarget(f.event.eventId, f.team.teamId, f.job.problemId)).rejects.toThrow(
      "Corrupt deployment target ownership",
    );
  });
  it("checks connection scope, requires consecutive versions and preserves a winning concurrent registration", async () => {
    const f = fixture();
    const connection = f.job.connection;
    f.send.mockImplementationOnce(async () => ({ Item: connection }));
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toEqual(connection);
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.getConnection(f.event.eventId, f.team.teamId)).toBeUndefined();
    f.send.mockImplementationOnce(async () => ({ Item: { ...connection, teamId: ulid() } }));
    await expect(f.work.getConnection(f.event.eventId, f.team.teamId)).rejects.toThrow(
      "scope mismatch",
    );
    await expect(f.work.saveVerifiedConnection({ ...connection, version: 3 }, 1)).rejects.toThrow(
      "version",
    );
    f.send.mockImplementationOnce(async () => ({}));
    await f.work.saveVerifiedConnection(connection);
    expect(transaction(f.send.mock.calls.at(-1)?.[0])[0]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(PK)",
    );
    f.send.mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.saveVerifiedConnection({ ...connection, version: 2 }, 1)).rejects.toThrow(
      "connection_changed",
    );
    expect(transaction(f.send.mock.calls.at(-1)?.[0])[0]?.Put?.ExpressionAttributeValues).toEqual({
      ":version": 1,
    });
  });
  it("atomically retains the failed attempt when accepting a retry, but rejects a changed attempt", async () => {
    const f = fixture();
    const input = { ...f.accept, job: { ...f.job, attempt: 2 }, retryOf: 1 };
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "FAILED" } }))
      .mockImplementationOnce(async () => ({}));
    expect((await f.work.accept(input)).kind).toBe("accepted");
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes.find((write) => write.Put?.Item?.SK === "ATTEMPT#1")?.Put?.Item?.status).toBe(
      "FAILED",
    );
    expect(writes[3]?.Put?.ConditionExpression).toContain("score = :zero");
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, attempt: 3 } }));
    await expect(f.work.accept(input)).rejects.toThrow("retry_attempt_changed");
  });
  it("returns the winning acceptance receipt after a transaction conflict without retrying a second job", async () => {
    const f = fixture();
    f.send
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({
        Item: { requestHash: f.accept.requestHash, response: { jobId: f.job.jobId, attempt: 1 } },
      }));
    expect((await f.work.accept(f.accept)).kind).toBe("replay");
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  it("bounds retries and rejects a persistently conflicting acceptance", async () => {
    const f = fixture();
    f.send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) throw conditionalFailure();
      return {};
    });
    await expect(f.work.accept(f.accept)).rejects.toThrow("deployment_acceptance_conflict");
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(12);
  });
  it("queries only team-owned public score history and rejects rows from a different owner", async () => {
    const f = fixture();
    const row = {
      eventId: f.event.eventId,
      teamId: f.team.teamId,
      jobId: f.job.jobId,
      problemId: f.job.problemId,
      points: 100,
      source: "flag",
      result: "ok",
      occurredAt: AT,
      privateSecret: "not-public",
    };
    f.send.mockImplementationOnce(async () => ({ Items: [row] }));
    const history = await f.work.listScoreEvents(f.event.eventId, f.team.teamId, 7);
    expect(history).toHaveLength(1);
    expect(history[0]).not.toHaveProperty("privateSecret");
    expect(history[0]).not.toHaveProperty("eventId");
    f.send.mockImplementationOnce(async () => ({ Items: [{ ...row, teamId: ulid() }] }));
    await expect(f.work.listScoreEvents(f.event.eventId, f.team.teamId)).rejects.toThrow(
      "ownership mismatch",
    );
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.listScoreEvents(f.event.eventId, f.team.teamId)).toEqual([]);
    await expect(f.work.listScoreEvents(f.event.eventId, f.team.teamId, 101)).rejects.toThrow(
      "history limit",
    );
  });
  it("reads durable pending dispatch without leaking extra fields", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({ Items: [{ ...f.job, secret: "not-returned" }] }));
    expect(await f.work.listDispatch()).toEqual([
      {
        jobId: f.job.jobId,
        eventId: f.event.eventId,
        teamId: f.team.teamId,
        attempt: 1,
        createdAt: AT,
      },
    ]);
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.listDispatch()).toEqual([]);
  });
  it("replays an owned claim and rejects invalid ownership or a lost claim race", async () => {
    const f = fixture();
    await expect(f.work.begin(f.job, "", AT)).rejects.toThrow("workflow owner");
    f.send.mockImplementationOnce(async () => ({
      Item: { ...f.job, status: "IN_PROGRESS", owner: "same" },
    }));
    expect(await f.work.begin(f.job, "same", AT)).toBe("replay");
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.begin(f.job, "other", AT)).rejects.toThrow("claim_conflict");
  });
  it("fails a pre-claim execution only with pending-attempt CAS and removes its dispatch in the same commit", async () => {
    const f = fixture();
    await expect(f.work.failPending(f.job, "", AT)).rejects.toThrow("bounded");
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.failPending(f.job, "synthetic workflow failed", AT)).toBe("updated");
    const writes = transaction(f.send.mock.calls.at(-1)?.[0]);
    expect(writes[0]?.Update?.ConditionExpression).toContain("#status = :pending");
    expect(writes[1]?.Delete?.Key?.PK).toBe("DISPATCH#PENDING");
    f.send.mockImplementationOnce(async () => ({ Item: { ...f.job, status: "FAILED" } }));
    expect(await f.work.failPending(f.job, "same", AT)).toBe("replay");
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.failPending(f.job, "same", AT)).rejects.toThrow("pending_failure_conflict");
  });
  it("recovers matching terminal writes but never overwrites another owner's result", async () => {
    const f = fixture();
    const completion = { status: "FAILED" as const, failureReason: "synthetic" };
    const done = {
      ...f.job,
      ...completion,
      owner: "owner",
      completionDigest: contentDigest(JSON.stringify(completion)),
    };
    f.send.mockImplementationOnce(async () => ({ Item: done }));
    expect(await f.work.finish(f.job, "owner", completion, AT)).toBe("replay");
    f.send.mockImplementationOnce(async () => ({ Item: done }));
    await expect(
      f.work.finish(f.job, "owner", { ...completion, failureReason: "different" }, AT),
    ).rejects.toThrow("payload_changed");
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, owner: "owner", status: "IN_PROGRESS" },
      }))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({ Item: done }));
    expect(await f.work.finish(f.job, "owner", completion, AT)).toBe("replay");
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, owner: "owner", status: "IN_PROGRESS" },
      }))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({ Item: { ...done, owner: "other" } }));
    await expect(f.work.finish(f.job, "owner", completion, AT)).rejects.toThrow(
      "transition_conflict",
    );
  });
  it("refuses invalid or unready flag requests and does not bypass revoked access through a receipt", async () => {
    const f = fixture();
    await expect(f.work.submitFlag({ ...f.flag, attempt: 0 })).rejects.toThrow("invalid_scoring");
    await expect(
      f.work.submitFlag({ ...f.flag, event: { ...f.event, scoringLocked: true } }),
    ).rejects.toThrow("scoring_locked");
    f.send.mockImplementationOnce(async () => ({ Item: f.job }));
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("not_ready");
    const done = {
      ...f.job,
      status: "COMPLETE",
      flagDigest: flagDigest("correct"),
      flagSubmitted: true,
      score: 100,
    };
    f.send
      .mockImplementationOnce(async () => ({ Item: done }))
      .mockImplementationOnce(async () => ({
        Item: {
          requestHash: contentDigest(JSON.stringify([f.job.jobId, 1, "correct"])),
          response: { kind: "ok", scoreDelta: 100, totalScore: 100 },
        },
      }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("scope_or_access_changed");
    f.send
      .mockImplementationOnce(async () => ({ Item: done }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.submitFlag({ ...f.flag, requestKey: "new" })).toEqual({
      kind: "already_scored",
      totalScore: 100,
    });
    expect(transaction(f.send.mock.calls.at(-1)?.[0])).toHaveLength(4);
  });
  it("bounds scoring contention instead of claiming uncertain success", async () => {
    const f = fixture();
    let reads = 0;
    f.send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) throw conditionalFailure();
      reads++;
      return reads % 2 === 1
        ? { Item: { ...f.job, status: "COMPLETE", flagDigest: flagDigest("correct") } }
        : {};
    });
    await expect(f.work.submitFlag(f.flag)).rejects.toThrow("scoring_scope_or_access_changed");
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(24);
  });
});

function teardownFixture() {
  const f = fixture();
  const identity: DeploymentIdentity = {
    eventId: f.event.eventId,
    teamId: f.team.teamId,
    jobId: f.job.jobId,
    attempt: 1,
    operation: "delete",
    generation: 1,
  };
  const reference = {
    stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${f.job.stackName}/synthetic-id`,
    fingerprint: "a".repeat(64),
  };
  const creation: CreationReservation = { ...identity, state: "NOT_STARTED", leaseUntil: 0 };
  const marker: TeardownRecord = {
    ...identity,
    generation: 1,
    status: "PENDING",
    requestedAt: AT,
    updatedAt: AT,
  };
  return { ...f, identity, reference, creation, marker };
}
function getInput(value: unknown) {
  if (!(value instanceof GetCommand)) throw new Error("Expected strong GetCommand");
  expect(value.input.ConsistentRead).toBe(true);
  return value.input;
}
function targetRow(job: DeploymentJob) {
  return { jobId: job.jobId, attempt: job.attempt, SK: `TARGET#${contentDigest(job.problemId)}` };
}

describe("event teardown closure and authoritative targets with intercepted SDK", () => {
  it("closes and locks scoring with an event-revision CAS without resetting prior completion", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.closeEvent(f.event, AT)).toBe("closing");
    const update = transaction(f.send.mock.calls[0]?.[0])[0]?.Update;
    expect(update?.Key).toEqual({ PK: `EVENT#${f.event.eventId}`, SK: "META" });
    expect(update?.ConditionExpression).toBe("updatedAt = :previous AND #status <> :archived");
    expect(update?.UpdateExpression).toContain(
      "teardownCompleted = if_not_exists(teardownCompleted, :zero)",
    );
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ":closing": "TEARDOWN",
      ":yes": true,
      ":previous": f.event.updatedAt,
    });
  });

  it.each(["TEARDOWN", "ARCHIVED"] as const)(
    "does not rewrite an already %s event",
    async (status) => {
      const f = fixture();
      expect(await f.work.closeEvent({ ...f.event, status }, AT)).toBe(
        status === "ARCHIVED" ? "archived" : "closing",
      );
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it.each(["TEARDOWN", "ARCHIVED", "READY", undefined] as const)(
    "reconciles a lost close CAS against strong status %s",
    async (status) => {
      const f = fixture();
      f.send.mockRejectedValueOnce(conditionalFailure()).mockImplementationOnce(async () => ({
        Item: status ? { ...f.event, status } : undefined,
      }));
      const result = f.work.closeEvent(f.event, AT);
      if (status === "TEARDOWN" || status === "ARCHIVED")
        expect(await result).toBe(status === "ARCHIVED" ? "archived" : "closing");
      else await expect(result).rejects.toThrow("event_teardown_conflict");
      expect(getInput(f.send.mock.calls[1]?.[0]).TableName).toBe("events");
    },
  );

  it.each([-1, 2451, 1.5])(
    "rejects invalid expected target count %s before writing",
    async (count) => {
      const f = fixture();
      await expect(f.work.setTeardownExpected(f.event.eventId, count)).rejects.toThrow(
        "target count",
      );
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("pins the expected target set and archives only on exact recorded counter equality", async () => {
    const f = fixture();
    f.send.mockImplementation(async () => ({}));
    await f.work.setTeardownExpected(f.event.eventId, 25);
    const expected = transaction(f.send.mock.calls[0]?.[0])[0]?.Update;
    expect(expected?.ConditionExpression).toBe(
      "#status = :closing AND (attribute_not_exists(teardownExpected) OR teardownExpected = :count)",
    );
    expect(expected?.ExpressionAttributeValues?.[":count"]).toBe(25);
    expect(await f.work.archiveTeardown(f.event.eventId)).toBe(true);
    const archive = transaction(f.send.mock.calls[1]?.[0])[0]?.Update;
    expect(archive?.ConditionExpression).toBe(
      "#status = :closing AND attribute_exists(teardownExpected) AND teardownCompleted = teardownExpected",
    );
    expect(archive?.UpdateExpression).toBe("SET #status = :archived");
    f.send.mockRejectedValueOnce(conditionalFailure());
    expect(await f.work.archiveTeardown(f.event.eventId)).toBe(false);
  });

  it.each(["same-archive", "changed-archive", "still-closing", "missing"])(
    "handles expected-count CAS conflict for %s",
    async (kind) => {
      const f = fixture();
      const Item =
        kind === "missing"
          ? undefined
          : {
              ...f.event,
              status: kind === "still-closing" ? "TEARDOWN" : "ARCHIVED",
              teardownExpected: kind === "changed-archive" ? 24 : 25,
            };
      f.send
        .mockRejectedValueOnce(conditionalFailure())
        .mockImplementationOnce(async () => ({ Item }));
      const result = f.work.setTeardownExpected(f.event.eventId, 25);
      if (kind === "same-archive") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("teardown_target_set_changed");
      getInput(f.send.mock.calls[1]?.[0]);
    },
  );

  it("paginates base-table TARGET rows and strongly resolves every owned job", async () => {
    const f = fixture();
    const second = { ...f.job, jobId: ulid(), problemId: "second" };
    const cursor = { PK: `EVENT#${f.event.eventId}#TEAM#${f.team.teamId}`, SK: "TARGET#cursor" };
    f.send
      .mockImplementationOnce(async () => ({ Items: [targetRow(f.job)], LastEvaluatedKey: cursor }))
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({ Items: [] }))
      .mockImplementationOnce(async () => ({ Items: [targetRow(second)] }))
      .mockImplementationOnce(async () => ({ Item: second }))
      .mockImplementationOnce(async () => ({ Items: [] }));
    expect(await f.work.listTargetJobs(f.event.eventId, f.team.teamId)).toEqual([f.job, second]);
    for (const index of [0, 3]) {
      const command = f.send.mock.calls[index]?.[0];
      if (!(command instanceof QueryCommand)) throw new Error("Expected TARGET query");
      expect(command.input).toMatchObject({
        TableName: "deployments",
        ConsistentRead: true,
        Limit: 100,
        ExpressionAttributeValues: { ":pk": cursor.PK, ":prefix": "TARGET#" },
      });
      expect(command.input.IndexName).toBeUndefined();
      expect(command.input.ExclusiveStartKey).toEqual(index === 0 ? undefined : cursor);
    }
    expect(getInput(f.send.mock.calls[1]?.[0]).Key?.PK).toBe(`DEPLOYMENT#${f.job.jobId}`);
    expect(getInput(f.send.mock.calls[4]?.[0]).Key?.PK).toBe(`DEPLOYMENT#${second.jobId}`);
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.listTargetJobs(f.event.eventId, f.team.teamId)).toEqual([]);
  });

  it.each(["missing", "event", "team", "attempt", "problem"])(
    "rejects %s drift in authoritative target ownership",
    async (field) => {
      const f = fixture();
      const changes = {
        event: { eventId: ulid() },
        team: { teamId: ulid() },
        attempt: { attempt: 2 },
        problem: { problemId: "other" },
        missing: {},
      };
      f.send
        .mockImplementationOnce(async () => ({ Items: [targetRow(f.job)] }))
        .mockImplementationOnce(async () => ({
          Item:
            field === "missing"
              ? undefined
              : { ...f.job, ...changes[field as keyof typeof changes] },
        }));
      await expect(f.work.listTargetJobs(f.event.eventId, f.team.teamId)).rejects.toThrow(
        "Corrupt teardown target ownership",
      );
      expect(f.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
        false,
      );
    },
  );
});

describe("durable creation proof and immutable stack references with intercepted SDK", () => {
  it.each(["jobId", "eventId", "teamId", "attempt"] as const)(
    "rejects creation receipt %s drift on a strong read",
    async (field) => {
      const f = teardownFixture();
      f.send.mockImplementationOnce(async () => ({
        Item: { ...f.creation, [field]: field === "attempt" ? 2 : ulid() },
      }));
      await expect(f.work.getCreation(f.identity)).rejects.toThrow("creation_scope_changed");
      expect(getInput(f.send.mock.calls[0]?.[0]).Key?.SK).toBe("CREATE#1");
    },
  );

  it.each([undefined, "NOT_STARTED", "REQUESTED", "ACKNOWLEDGED"] as const)(
    "reserves from %s using a state CAS, preserving acknowledged identity",
    async (state) => {
      const f = teardownFixture();
      const prior = state
        ? {
            ...f.creation,
            state,
            ...(state === "ACKNOWLEDGED" ? { ...f.reference, owner: "creator" } : {}),
          }
        : undefined;
      f.send
        .mockImplementationOnce(async () => ({ Item: prior }))
        .mockImplementationOnce(async () => ({}));
      await f.work.reserveCreation(f.identity, "creator", NOW);
      const writes = transaction(f.send.mock.calls[1]?.[0]);
      expect(writes).toHaveLength(3);
      expect(writes[0]?.ConditionCheck?.ConditionExpression).toBe(
        "#status IN (:draft, :deploying, :ready) AND expiresAt > :now",
      );
      expect(writes[1]?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({
        ":owner": "creator",
        ":status": "IN_PROGRESS",
        ":attempt": 1,
      });
      expect(writes[2]?.Put?.Item).toMatchObject({
        state: state === "ACKNOWLEDGED" ? state : "REQUESTED",
        owner: "creator",
        leaseUntil: NOW + 120_000,
        SK: "CREATE#1",
      });
      if (state) {
        expect(writes[2]?.Put?.ConditionExpression).toContain("#state = :previous");
        expect(writes[2]?.Put?.ExpressionAttributeValues?.[":previous"]).toBe(state);
      } else expect(writes[2]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
      if (state === "ACKNOWLEDGED") expect(writes[2]?.Put?.Item).toMatchObject(f.reference);
    },
  );

  it("distinguishes a missing proof from NOT_STARTED and refuses owner or event-close races", async () => {
    const f = teardownFixture();
    f.send.mockImplementationOnce(async () => ({}));
    expect(await f.work.getCreation(f.identity)).toBeUndefined();
    f.send.mockImplementationOnce(async () => ({ Item: { ...f.creation, owner: "other" } }));
    await expect(f.work.reserveCreation(f.identity, "creator", NOW)).rejects.toThrow(
      "creation_owner_changed",
    );
    expect(f.send).toHaveBeenCalledTimes(2);
    f.send
      .mockImplementationOnce(async () => ({ Item: f.creation }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.reserveCreation(f.identity, "creator", NOW)).rejects.toThrow(
      "creation_closed_or_owner_changed",
    );
    const denied = new Error("Synthetic access denial");
    f.send.mockImplementationOnce(async () => ({ Item: f.creation })).mockRejectedValueOnce(denied);
    await expect(f.work.reserveCreation(f.identity, "creator", NOW)).rejects.toBe(denied);
  });

  it.each(["creation", "teardown"] as const)(
    "records a scoped %s reference with ownership and exact-identity CAS",
    async (kind) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: f.job }))
        .mockImplementationOnce(async () => ({}));
      const record =
        kind === "creation"
          ? () => f.work.recordCreation(f.identity, "owner", f.reference)
          : () => f.work.recordTeardownReference(f.identity, "owner", f.reference);
      await record();
      const update = transaction(f.send.mock.calls[1]?.[0])[0]?.Update;
      expect(update?.Key?.SK).toBe(kind === "creation" ? "CREATE#1" : "TEARDOWN");
      expect(update?.ConditionExpression).toContain("#owner = :owner");
      expect(update?.ConditionExpression).toContain(
        "attribute_not_exists(stackId) OR (stackId = :stack AND fingerprint = :fingerprint)",
      );
      expect(update?.ExpressionAttributeValues).toMatchObject({
        ":stack": f.reference.stackId,
        ":fingerprint": f.reference.fingerprint,
      });
      if (kind === "teardown") {
        expect(update?.ConditionExpression).toContain(
          "generation = :generation AND #status = :running",
        );
        expect(update?.ExpressionAttributeValues?.[":generation"]).toBe(1);
      } else expect(update?.ExpressionAttributeValues?.[":ack"]).toBe("ACKNOWLEDGED");
      f.send
        .mockImplementationOnce(async () => ({ Item: f.job }))
        .mockRejectedValueOnce(conditionalFailure());
      await expect(record()).rejects.toThrow(
        kind === "creation" ? "creation_receipt_changed" : "teardown_reference_changed",
      );
    },
  );

  it.each(["account", "region", "name", "suffix", "fingerprint"])(
    "rejects reference %s drift before either durable reference write",
    async (field) => {
      const f = teardownFixture();
      const invalid = { ...f.reference };
      if (field === "account")
        invalid.stackId = invalid.stackId.replace("123456789012", "999999999999");
      if (field === "region") invalid.stackId = invalid.stackId.replace("us-east-1", "us-west-2");
      if (field === "name") invalid.stackId = invalid.stackId.replace("stack/tc-", "stack/other-");
      if (field === "suffix") invalid.stackId += "/other";
      if (field === "fingerprint") invalid.fingerprint = "not-a-digest";
      f.send.mockImplementation(async () => ({ Item: f.job }));
      await expect(f.work.recordCreation(f.identity, "owner", invalid)).rejects.toThrow(
        "stack_reference_scope_changed",
      );
      await expect(f.work.recordTeardownReference(f.identity, "owner", invalid)).rejects.toThrow(
        "stack_reference_scope_changed",
      );
      expect(f.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
    },
  );
});

describe("teardown requests and source convergence with intercepted SDK", () => {
  it.each(["jobId", "eventId", "teamId", "attempt", "generation"] as const)(
    "rejects teardown marker %s drift",
    async (field) => {
      const f = teardownFixture();
      f.send.mockImplementationOnce(async () => ({
        Item: { ...f.marker, [field]: ["attempt", "generation"].includes(field) ? 2 : ulid() },
      }));
      await expect(f.work.getTeardown(f.identity)).rejects.toThrow(
        "teardown_scope_or_generation_changed",
      );
      expect(getInput(f.send.mock.calls[0]?.[0]).Key?.SK).toBe("TEARDOWN");
    },
  );

  it("atomically cancels pending work, removes original dispatch and increments completion once", async () => {
    const f = teardownFixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure());
    expect(await f.work.requestTeardown(f.identity, AT)).toBe("enqueued");
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes).toHaveLength(4);
    expect(writes[0]?.Update).toMatchObject({
      TableName: "events",
      UpdateExpression: "ADD teardownCompleted :one",
      ConditionExpression: "#status = :closing",
    });
    expect(writes[1]?.Update?.UpdateExpression).toContain("#status = :deleted");
    expect(writes[1]?.Update?.ConditionExpression).toContain("revision = :revision");
    expect(writes[2]?.Put?.Item).toMatchObject({
      status: "DELETED",
      generation: 1,
      SK: "TEARDOWN",
    });
    expect(writes[3]?.Delete?.Key).toEqual({ PK: "DISPATCH#PENDING", SK: `${f.job.jobId}#1` });
    expect(transaction(f.send.mock.calls[3]?.[0])[0]?.Update?.ConditionExpression).toContain(
      "teardownCompleted = teardownExpected",
    );
    f.send
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETED" } }))
      .mockImplementationOnce(async () => ({ Item: { ...f.marker, status: "DELETED" } }));
    expect(await f.work.requestTeardown(f.identity, AT)).toBe("skipped");
    expect(f.send).toHaveBeenCalledTimes(6);
  });

  it("enqueues active teardown without deleting original job data or incrementing completion", async () => {
    const f = teardownFixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "IN_PROGRESS" } }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.requestTeardown(f.identity, AT)).toBe("enqueued");
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes[0]?.ConditionCheck?.ExpressionAttributeValues).toEqual({
      ":closing": "TEARDOWN",
    });
    expect(writes[1]?.Update?.UpdateExpression).toBe(
      "SET teardownStatus = :teardown REMOVE teardownFailureReason",
    );
    expect(writes[2]?.Put?.Item?.status).toBe("PENDING");
    expect(writes[3]?.Put?.Item).toMatchObject({
      PK: "DISPATCH#PENDING",
      SK: `${f.job.jobId}#1#DELETE#1`,
      operation: "delete",
      generation: 1,
    });
    expect(writes.some((write) => write.Update?.TableName === "events")).toBe(false);
  });

  it("retries FAILED teardown with a new generation but the same original physical reference", async () => {
    const f = teardownFixture();
    const old = {
      ...f.marker,
      ...f.reference,
      status: "FAILED",
      owner: "old-owner",
      failureReason: "synthetic",
    };
    const retryAt = new Date(NOW + 1000).toISOString();
    f.send
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
      .mockImplementationOnce(async () => ({ Item: old }))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.requestTeardown({ ...f.identity, generation: undefined }, retryAt)).toBe(
      "enqueued",
    );
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    const marker = writes[2]?.Put;
    expect(marker?.Item).toMatchObject({
      ...f.reference,
      generation: 2,
      status: "PENDING",
      requestedAt: AT,
      updatedAt: retryAt,
    });
    expect(marker?.Item).not.toHaveProperty("owner");
    expect(marker?.Item).not.toHaveProperty("failureReason");
    expect(marker?.ConditionExpression).toBe("generation = :generation AND #status = :failed");
    expect(marker?.ExpressionAttributeValues).toEqual({ ":generation": 1, ":failed": "FAILED" });
    expect(writes[3]?.Put?.Item?.SK).toBe(`${f.job.jobId}#1#DELETE#2`);
  });

  it.each(["PENDING", "IN_PROGRESS", "DELETED"] as const)(
    "does not duplicate an existing %s teardown",
    async (status) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "COMPLETE" } }))
        .mockImplementationOnce(async () => ({ Item: { ...f.marker, status } }));
      expect(await f.work.requestTeardown(f.identity, AT)).toBe("skipped");
      expect(f.send).toHaveBeenCalledTimes(2);
    },
  );

  it("reconciles a competing teardown request and bounds persistent CAS failures", async () => {
    const f = teardownFixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure())
      .mockImplementationOnce(async () => ({ Item: f.job }))
      .mockImplementationOnce(async () => ({ Item: f.marker }));
    expect(await f.work.requestTeardown(f.identity, AT)).toBe("skipped");
    f.send.mockClear();
    f.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return { Item: command.input.Key?.SK === "META" ? f.job : undefined };
      if (command instanceof TransactWriteCommand) throw conditionalFailure();
      throw new Error("Unexpected SDK command");
    });
    await expect(f.work.requestTeardown(f.identity, AT)).rejects.toThrow(
      "teardown_request_conflict",
    );
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(8);
  });

  it("claims teardown and removes only its generation dispatch atomically, then replays the same owner", async () => {
    const f = teardownFixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: f.marker }))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.beginTeardown(f.identity, "owner", AT)).toBe("started");
    const writes = transaction(f.send.mock.calls[1]?.[0]);
    expect(writes).toHaveLength(3);
    expect(writes[1]?.Update?.ConditionExpression).toBe(
      "generation = :generation AND #status = :pending",
    );
    expect(writes[1]?.Update?.ExpressionAttributeValues?.[":owner"]).toBe("owner");
    expect(writes[2]?.Delete?.Key?.SK).toBe(`${f.job.jobId}#1#DELETE#1`);
    f.send.mockImplementationOnce(async () => ({
      Item: { ...f.marker, status: "IN_PROGRESS", owner: "owner" },
    }));
    expect(await f.work.beginTeardown(f.identity, "owner", AT)).toBe("replay");
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.marker, status: "IN_PROGRESS", owner: "other" },
      }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.beginTeardown(f.identity, "owner", AT)).rejects.toThrow(
      "teardown_claim_conflict",
    );
  });

  it("rejects invalid teardown intent or missing markers without claiming anything", async () => {
    const f = teardownFixture();
    await expect(
      f.work.beginTeardown({ ...f.identity, operation: undefined }, "owner", AT),
    ).rejects.toThrow("invalid_teardown_identity");
    await expect(
      f.work.beginTeardown({ ...f.identity, generation: 0 }, "owner", AT),
    ).rejects.toThrow("invalid_teardown_identity");
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(async () => ({}));
    await expect(f.work.beginTeardown(f.identity, "owner", AT)).rejects.toThrow("teardown_missing");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["IN_PROGRESS", 0],
    ["IN_PROGRESS", NOW - 1],
    ["COMPLETE", NOW + 1],
  ] as const)(
    "waits on source %s and lease %s without preparing deletion",
    async (status, leaseUntil) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status } }))
        .mockImplementationOnce(async () => ({ Item: { ...f.creation, leaseUntil } }));
      expect(await f.work.prepareDeletion(f.identity, "owner", NOW)).toBe(false);
      expect(f.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
    },
  );

  it.each(["COMPLETE", "FAILED", "DELETING"] as const)(
    "prepares terminal %s with closing-event, owner and generation guards",
    async (status) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status } }))
        .mockImplementationOnce(async () => ({}))
        .mockImplementationOnce(async () => ({}));
      expect(await f.work.prepareDeletion(f.identity, "owner", NOW)).toBe(true);
      const writes = transaction(f.send.mock.calls[2]?.[0]);
      expect(writes).toHaveLength(3);
      expect(writes[1]?.ConditionCheck?.ConditionExpression).toBe(
        "generation = :generation AND #status = :running AND #owner = :owner",
      );
      expect(writes[1]?.ConditionCheck?.ExpressionAttributeValues).toEqual({
        ":generation": 1,
        ":running": "IN_PROGRESS",
        ":owner": "owner",
      });
      expect(writes[2]?.Update?.ConditionExpression).toBe(
        "attempt = :attempt AND #status = :previous",
      );
      expect(writes[2]?.Update?.ExpressionAttributeValues?.[":previous"]).toBe(status);
      expect(writes[2]?.Update?.ExpressionAttributeValues?.[":deleting"]).toBe("DELETING");
    },
  );

  it.each(["PENDING", "DELETED", "EXPIRED"] as const)(
    "does not prepare unexpected source status %s",
    async (status) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status } }))
        .mockImplementationOnce(async () => ({}));
      await expect(f.work.prepareDeletion(f.identity, "owner", NOW)).rejects.toThrow(
        "teardown_source_not_terminal",
      );
      expect(f.send).toHaveBeenCalledTimes(2);
    },
  );

  it("does not turn expired REQUESTED into proof of deletion and rejects a lost owner/generation CAS", async () => {
    const f = teardownFixture();
    f.send
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "FAILED" } }))
      .mockImplementationOnce(async () => ({
        Item: { ...f.creation, state: "REQUESTED", leaseUntil: NOW - 1 },
      }))
      .mockRejectedValueOnce(conditionalFailure());
    await expect(f.work.prepareDeletion(f.identity, "stale-owner", NOW)).rejects.toThrow(
      "teardown_prepare_conflict",
    );
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes.some((write) => write.Update?.TableName === "events")).toBe(false);
    expect(writes.some((write) => write.Update?.Key?.SK === "CREATE#1")).toBe(false);
    expect(writes[1]?.ConditionCheck?.ExpressionAttributeValues?.[":owner"]).toBe("stale-owner");
  });
});

describe("atomic teardown completion, retry and archival with intercepted SDK", () => {
  it("commits terminal marker, job state and one event increment together without replacing score history", async () => {
    const f = teardownFixture();
    const marker = { ...f.marker, ...f.reference, status: "IN_PROGRESS", owner: "owner" };
    f.send
      .mockImplementationOnce(async () => ({ Item: marker }))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING", score: 100 } }))
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(conditionalFailure());
    expect(
      await f.work.finishTeardown(
        f.identity,
        "owner",
        { status: "DELETED", stackId: f.reference.stackId },
        AT,
      ),
    ).toBe("updated");
    const writes = transaction(f.send.mock.calls[2]?.[0]);
    expect(writes).toHaveLength(3);
    expect(writes[0]?.Put?.Item).toMatchObject({
      ...f.reference,
      status: "DELETED",
      owner: "owner",
    });
    expect(writes[0]?.Put?.ConditionExpression).toBe(
      "generation = :generation AND #status = :expected AND #owner = :owner",
    );
    expect(writes[1]?.Update?.ConditionExpression).toBe(
      "attempt = :attempt AND #status = :previous",
    );
    expect(writes[1]?.Update?.UpdateExpression).not.toMatch(
      /score|publicOutputs|flagDigest|revision/u,
    );
    expect(writes[2]?.Update?.UpdateExpression).toBe("ADD teardownCompleted :one");
    expect(writes[2]?.Update?.ExpressionAttributeValues?.[":one"]).toBe(1);
    expect(writes.some((write) => write.Delete)).toBe(false);
    expect(transaction(f.send.mock.calls[3]?.[0])[0]?.Update?.ConditionExpression).toContain(
      "teardownCompleted = teardownExpected",
    );
  });

  it.each(["owner", undefined])(
    "persists partial failure with owner %s without increasing completion or archiving",
    async (owner) => {
      const f = teardownFixture();
      const marker = {
        ...f.marker,
        ...f.reference,
        status: owner ? "IN_PROGRESS" : "PENDING",
        ...(owner ? { owner } : {}),
      };
      f.send
        .mockImplementationOnce(async () => ({ Item: marker }))
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "COMPLETE" } }))
        .mockImplementationOnce(async () => ({}));
      expect(
        await f.work.finishTeardown(
          f.identity,
          owner,
          { status: "FAILED", failureReason: "synthetic DELETE_FAILED" },
          AT,
        ),
      ).toBe("updated");
      const writes = transaction(f.send.mock.calls[2]?.[0]);
      expect(writes).toHaveLength(owner ? 2 : 3);
      expect(writes[0]?.Put?.Item).toMatchObject({ ...f.reference, status: "FAILED" });
      expect(writes[1]?.Update?.UpdateExpression).toContain("teardownFailureReason = :reason");
      expect(writes[1]?.Update?.UpdateExpression).not.toContain("#status = :deleted");
      expect(writes.some((write) => write.Update?.TableName === "events")).toBe(false);
      if (!owner) {
        expect(writes[0]?.Put?.ConditionExpression).toContain("attribute_not_exists(#owner)");
        expect(writes[2]?.Delete?.Key?.SK).toBe(`${f.job.jobId}#1#DELETE#1`);
      }
      expect(f.send).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["DELETED", "FAILED"] as const)(
    "replays a terminal %s without another counter update",
    async (status) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({ Item: { ...f.marker, status, owner: "owner" } }))
        .mockImplementationOnce(async () => ({}));
      expect(
        await f.work.finishTeardown(
          f.identity,
          "owner",
          { status, ...(status === "FAILED" ? { failureReason: "synthetic" } : {}) },
          AT,
        ),
      ).toBe("replay");
      expect(f.send).toHaveBeenCalledTimes(status === "DELETED" ? 2 : 1);
      if (status === "DELETED")
        expect(transaction(f.send.mock.calls[1]?.[0])[0]?.Update?.UpdateExpression).toBe(
          "SET #status = :archived",
        );
    },
  );

  it("rejects a stale owner, an unprepared source, and unbounded failure reasons before terminal writes", async () => {
    const f = teardownFixture();
    for (const failureReason of ["", "x".repeat(2001)])
      await expect(
        f.work.finishTeardown(f.identity, "owner", { status: "FAILED", failureReason }, AT),
      ).rejects.toThrow("bounded");
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(async () => ({
      Item: { ...f.marker, owner: "other", status: "IN_PROGRESS" },
    }));
    await expect(
      f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_owner_changed");
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.marker, owner: "owner", status: "IN_PROGRESS" },
      }))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "IN_PROGRESS" } }));
    await expect(
      f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_not_deleting");
    expect(f.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
  });

  it.each(["IN_PROGRESS", "DELETED"] as const)(
    "refuses completion that replaces a durably recorded physical stack in %s",
    async (status) => {
      const f = teardownFixture();
      f.send.mockImplementation(async (command) => {
        if (command instanceof GetCommand)
          return {
            Item:
              command.input.Key?.SK === "TEARDOWN"
                ? { ...f.marker, ...f.reference, owner: "owner", status }
                : { ...f.job, status: "DELETING" },
          };
        if (command instanceof TransactWriteCommand) return {};
        throw new Error("Unexpected SDK command");
      });
      await expect(
        f.work.finishTeardown(
          f.identity,
          "owner",
          { status: "DELETED", stackId: `${f.reference.stackId}-replacement` },
          AT,
        ),
      ).rejects.toThrow();
      expect(f.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
    },
  );

  it.each([undefined, "REQUESTED"] as const)(
    "rejects a DELETED result with no recorded ARN and %s creation proof",
    async (state) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({
          Item: { ...f.marker, status: "IN_PROGRESS", owner: "owner" },
        }))
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
        .mockImplementationOnce(async () => ({
          Item: state ? { ...f.creation, state } : undefined,
        }));
      await expect(
        f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT),
      ).rejects.toThrow("teardown_absence_unconfirmed");
      expect(getInput(f.send.mock.calls[2]?.[0]).Key?.SK).toBe("CREATE#1");
      expect(f.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
    },
  );

  it.each(["NOT_STARTED", "ACKNOWLEDGED"] as const)(
    "uses durable %s proof when the teardown marker has no ARN",
    async (state) => {
      const f = teardownFixture();
      f.send
        .mockImplementationOnce(async () => ({
          Item: { ...f.marker, status: "IN_PROGRESS", owner: "owner" },
        }))
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
        .mockImplementationOnce(async () => ({
          Item: { ...f.creation, state, ...(state === "ACKNOWLEDGED" ? f.reference : {}) },
        }))
        .mockImplementationOnce(async () => ({}))
        .mockImplementationOnce(async () => ({}));
      expect(await f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT)).toBe(
        "updated",
      );
      const marker = transaction(f.send.mock.calls[3]?.[0])[0]?.Put?.Item;
      if (state === "ACKNOWLEDGED") expect(marker?.stackId).toBe(f.reference.stackId);
      else expect(marker).not.toHaveProperty("stackId");
    },
  );

  it("inherits the original job ARN and rejects an unrelated completion ARN", async () => {
    const f = teardownFixture();
    const marker = { ...f.marker, status: "IN_PROGRESS", owner: "owner" };
    const job = { ...f.job, status: "DELETING", stackId: f.reference.stackId };
    f.send
      .mockImplementationOnce(async () => ({ Item: marker }))
      .mockImplementationOnce(async () => ({ Item: job }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT)).toBe(
      "updated",
    );
    expect(transaction(f.send.mock.calls[2]?.[0])[0]?.Put?.Item?.stackId).toBe(f.reference.stackId);
    f.send
      .mockImplementationOnce(async () => ({ Item: marker }))
      .mockImplementationOnce(async () => ({ Item: job }));
    await expect(
      f.work.finishTeardown(
        f.identity,
        "owner",
        { status: "DELETED", stackId: `${f.reference.stackId}-replacement` },
        AT,
      ),
    ).rejects.toThrow("teardown_reference_changed");
  });

  it("retries definite counter CAS conflicts, then commits once and separately checks archive", async () => {
    const f = teardownFixture();
    const marker = { ...f.marker, ...f.reference, status: "IN_PROGRESS", owner: "owner" };
    for (let retry = 0; retry < 2; retry++)
      f.send
        .mockImplementationOnce(async () => ({ Item: marker }))
        .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
        .mockRejectedValueOnce(conditionalFailure());
    f.send
      .mockImplementationOnce(async () => ({ Item: marker }))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => ({}));
    expect(await f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT)).toBe(
      "updated",
    );
    const transactions = f.send.mock.calls
      .filter(([command]) => command instanceof TransactWriteCommand)
      .map(([command]) => transaction(command));
    expect(transactions).toHaveLength(4);
    expect(
      transactions
        .slice(0, 3)
        .every(
          (writes) =>
            writes.length === 3 &&
            writes[2]?.Update?.UpdateExpression === "ADD teardownCompleted :one",
        ),
    ).toBe(true);
    expect(transactions[3]?.[0]?.Update?.UpdateExpression).toBe("SET #status = :archived");
  });

  it("bounds repeated terminal contention and propagates uncertain infrastructure errors immediately", async () => {
    const f = teardownFixture();
    f.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item:
            command.input.Key?.SK === "TEARDOWN"
              ? { ...f.marker, ...f.reference, status: "IN_PROGRESS", owner: "owner" }
              : { ...f.job, status: "DELETING" },
        };
      if (command instanceof TransactWriteCommand) throw conditionalFailure();
      throw new Error("Unexpected SDK command");
    });
    await expect(
      f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT),
    ).rejects.toThrow("teardown_finish_conflict");
    expect(
      f.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand),
    ).toHaveLength(16);
    f.send.mockReset();
    const uncertain = new Error("Synthetic transport response loss");
    f.send
      .mockImplementationOnce(async () => ({
        Item: { ...f.marker, ...f.reference, status: "IN_PROGRESS", owner: "owner" },
      }))
      .mockImplementationOnce(async () => ({ Item: { ...f.job, status: "DELETING" } }))
      .mockRejectedValueOnce(uncertain);
    await expect(
      f.work.finishTeardown(f.identity, "owner", { status: "DELETED" }, AT),
    ).rejects.toBe(uncertain);
    expect(f.send).toHaveBeenCalledTimes(3);
  });
});

it("requires an immutable claimed owner for a successful teardown, reserving ownerless recovery for failure", async () => {
  const f = fixture();
  const identity = { ...f.job, operation: "delete" as const, generation: 1 };
  await expect(f.work.beginTeardown(identity, "", AT)).rejects.toThrow("immutable teardown owner");
  await expect(f.work.beginTeardown(identity, "x".repeat(513), AT)).rejects.toThrow(
    "immutable teardown owner",
  );
  await expect(
    f.work.finishTeardown(identity, undefined, { status: "DELETED" }, AT),
  ).rejects.toThrow("teardown_owner_required");
  expect(f.send).not.toHaveBeenCalled();
});

describe("historical attempt blockers before claiming event teardown completeness", () => {
  it.each([
    "recorded-arn",
    "requested",
    "acknowledged",
    "unknown",
    "old-job",
    "old-event",
    "old-team",
    "old-problem",
  ])("rejects %s history before any cleanup mutation", async (reason) => {
    const f = fixture();
    const current = { ...f.job, attempt: 2 };
    const old = {
      ...f.job,
      status: "FAILED",
      PK: `DEPLOYMENT#${f.job.jobId}`,
      SK: "ATTEMPT#1",
      ...(reason === "recorded-arn"
        ? {
            awsAccountId: "999999999999",
            region: "us-west-2",
            stackId: `arn:aws:cloudformation:us-west-2:999999999999:stack/${f.job.stackName}/old-physical-id`,
          }
        : {}),
      ...(reason === "old-job" ? { jobId: ulid() } : {}),
      ...(reason === "old-event" ? { eventId: ulid() } : {}),
      ...(reason === "old-team" ? { teamId: ulid() } : {}),
      ...(reason === "old-problem" ? { problemId: "other" } : {}),
    };
    f.send
      .mockImplementationOnce(async () => ({ Items: [targetRow(current)] }))
      .mockImplementationOnce(async () => ({ Item: current }))
      .mockImplementationOnce(async () => ({ Items: [old] }))
      .mockImplementationOnce(async () => ({
        Item:
          reason === "unknown"
            ? undefined
            : {
                ...f.job,
                state: reason === "acknowledged" ? "ACKNOWLEDGED" : "REQUESTED",
                leaseUntil: 0,
              },
      }));
    await expect(f.work.listTargetJobs(f.event.eventId, f.team.teamId)).rejects.toThrow(
      reason.startsWith("old-")
        ? "historical_attempt_record_invalid"
        : "historical_attempt_resources_unresolved",
    );
    expect(f.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(
      false,
    );
    const history = f.send.mock.calls[2]?.[0];
    if (!(history instanceof QueryCommand)) throw new Error("Expected history query");
    expect(history.input.ConsistentRead).toBe(true);
    expect(history.input.ExpressionAttributeValues?.[":prefix"]).toBe("ATTEMPT#");
  });
  it("accepts only complete paginated history whose previous attempts were durably never started", async () => {
    const f = fixture();
    const current = { ...f.job, attempt: 3 };
    const cursor = { PK: `DEPLOYMENT#${f.job.jobId}`, SK: "ATTEMPT#1" };
    f.send
      .mockImplementationOnce(async () => ({ Items: [targetRow(current)] }))
      .mockImplementationOnce(async () => ({ Item: current }))
      .mockImplementationOnce(async () => ({
        Items: [{ ...f.job, SK: "ATTEMPT#1" }],
        LastEvaluatedKey: cursor,
      }))
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, state: "NOT_STARTED", leaseUntil: 0 },
      }))
      .mockImplementationOnce(async () => ({ Items: [{ ...f.job, attempt: 2, SK: "ATTEMPT#2" }] }))
      .mockImplementationOnce(async () => ({
        Item: { ...f.job, attempt: 2, state: "NOT_STARTED", leaseUntil: 0 },
      }));
    expect(await f.work.listTargetJobs(f.event.eventId, f.team.teamId)).toEqual([current]);
    const next = f.send.mock.calls[4]?.[0];
    if (!(next instanceof QueryCommand)) throw new Error("Expected second history page");
    expect(next.input.ExclusiveStartKey).toEqual(cursor);
  });
  it.each(["missing-history", "malformed", "future", "duplicate"])(
    "refuses %s instead of treating incomplete history as no resources",
    async (kind) => {
      const f = fixture();
      const current = { ...f.job, attempt: 2 };
      let rows: Record<string, unknown>[] = [];
      if (kind === "malformed") rows = [{}];
      if (kind === "future") rows = [{ ...f.job, attempt: 2, SK: "ATTEMPT#2" }];
      if (kind === "duplicate")
        rows = [
          { ...f.job, SK: "ATTEMPT#1" },
          { ...f.job, SK: "ATTEMPT#1" },
        ];
      f.send
        .mockImplementationOnce(async () => ({ Items: [targetRow(current)] }))
        .mockImplementationOnce(async () => ({ Item: current }))
        .mockImplementationOnce(async () => ({ Items: rows }))
        .mockImplementationOnce(async () => ({
          Item: { ...f.job, state: "NOT_STARTED", leaseUntil: 0 },
        }));
      await expect(f.work.listTargetJobs(f.event.eventId, f.team.teamId)).rejects.toThrow(
        "historical_attempt_",
      );
    },
  );
});
