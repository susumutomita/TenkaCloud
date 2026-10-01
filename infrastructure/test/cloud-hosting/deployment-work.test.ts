import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentDigest,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
  flagMatchesDigest,
  scoringBlock,
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
    expect(writes).toHaveLength(8);
    expect(writes.filter((write) => write.ConditionCheck)).toHaveLength(3);
    expect(writes.some((write) => write.Put?.Item?.PK === "DISPATCH#PENDING")).toBe(true);
    expect(writes.some((write) => write.Update?.Key?.SK === `SCORE#${f.team.teamId}`)).toBe(true);
    expect(writes.some((write) => write.Update?.Key?.SK === `TEAM#${f.team.teamId}`)).toBe(false);
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
    expect(writes[0]?.Put?.Item?.status).toBe("COMPLETE");
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
