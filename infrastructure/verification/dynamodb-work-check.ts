/** Explicit local-only acceptance. Uses official DynamoDB Local, never AWS or ambient credentials. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { z } from "zod";
import {
  bulkDeployEvent as clientBulkDeploy,
  createEvent as clientCreateEvent,
} from "../../apps/application-admin-console/src/api/events-client.js";
import { submitFlag as clientSubmitFlag } from "../../apps/participant-portal/src/api/portal-client/scoring.js";
import { POLL_INTERVAL_MS } from "../../apps/participant-portal/src/constants/polling.js";
import { createCoreApiClient } from "../../packages/web-kit/src/api-client.js";
import {
  contentDigest,
  type DeploymentIdentity,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
} from "../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";
import { DynamoDeploymentWork } from "../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { createCloudApp } from "../lib/problem-deploy/handlers/cloud-api/app.js";

const rawEndpoint = process.argv[2];
if (!rawEndpoint) throw new Error("Pass explicit http://127.0.0.1:<port> DynamoDB Local endpoint.");
const url = new URL(rawEndpoint);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  !url.port ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== "/"
)
  throw new Error("Only an explicit IPv4 loopback HTTP endpoint is permitted.");
const client = new DynamoDBClient({
  endpoint: url.href,
  region: "us-east-1",
  credentials: { accessKeyId: "DUMMYIDEXAMPLE", secretAccessKey: "DUMMYEXAMPLEKEY" },
  maxAttempts: 3,
});
const document = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
let measuring = false;
let metrics = { commands: 0, queryRows: 0, pointReads: 0, eventWideDeploymentQueries: 0 };
document.middlewareStack.add(
  (next, context) => async (args) => {
    const result = await next(args);
    if (measuring) {
      metrics.commands++;
      const out = z
        .object({ Items: z.array(z.unknown()).optional() })
        .passthrough()
        .parse(result.output);
      metrics.queryRows += out.Items?.length ?? 0;
      if (["GetCommand", "GetItemCommand"].includes(context.commandName ?? ""))
        metrics.pointReads++;
      const input = z
        .object({
          TableName: z.string().optional(),
          IndexName: z.string().optional(),
          KeyConditionExpression: z.string().optional(),
        })
        .passthrough()
        .parse(args.input);
      if (
        context.commandName === "QueryCommand" &&
        input.TableName === tables.deployments &&
        input.IndexName === "GSI1" &&
        !input.KeyConditionExpression?.includes("begins_with")
      )
        metrics.eventWideDeploymentQueries++;
    }
    return result;
  },
  { step: "initialize", name: "syntheticRowOpsMeasurement" },
);
const prefix = `TenkaCloudLocal-${randomUUID()}`;
const tables = {
  events: `${prefix}-events`,
  teams: `${prefix}-teams`,
  deployments: `${prefix}-deployments`,
};
const repository = () => new DynamoCloudRepository(document, tables);
const now = Date.now();
const at = new Date(now).toISOString();
const event: EventRecord = {
  eventId: ulid(),
  name: "Synthetic DynamoDB Local acceptance",
  status: "DRAFT",
  startsAt: new Date(now - 60_000).toISOString(),
  problems: Array.from({ length: 20 }, (_, index) => ({
    problemId: `problem-${index}`,
    defaultRegion: "us-east-1",
  })),
  teamCount: 25,
  createdAt: at,
  updatedAt: at,
  expiresAt: Math.floor(now / 1000) + 86400,
};
const teams: TeamRecord[] = Array.from({ length: 25 }, (_, index) => ({
  eventId: event.eventId,
  teamId: ulid(),
  internalSlug: `team-${index}`,
  teamLoginKey: randomBytes(32).toString("base64url"),
  authVersion: 1,
  accessRevoked: false,
  createdAt: at,
  updatedAt: at,
  expiresAt: event.expiresAt,
}));
const createdTables: string[] = [];
async function createTables(): Promise<void> {
  for (const [kind, TableName] of Object.entries(tables)) {
    const indexed = kind !== "teams";
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          ...(indexed
            ? [
                { AttributeName: "GSI1PK", AttributeType: "S" as const },
                { AttributeName: "GSI1SK", AttributeType: "S" as const },
              ]
            : []),
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        ...(indexed
          ? {
              GlobalSecondaryIndexes: [
                {
                  IndexName: "GSI1",
                  KeySchema: [
                    { AttributeName: "GSI1PK", KeyType: "HASH" },
                    { AttributeName: "GSI1SK", KeyType: "RANGE" },
                  ],
                  Projection: { ProjectionType: "ALL" },
                },
              ],
            }
          : {}),
      }),
    );
    createdTables.push(TableName);
  }
}

const work = () => new DynamoDeploymentWork(document, tables);
const jobs: DeploymentJob[] = [];
function makeJob(team: TeamRecord, index: number, sourceEvent = event): DeploymentJob {
  const problemId = `problem-${index}`;
  return {
    jobId: ulid(),
    eventId: sourceEvent.eventId,
    teamId: team.teamId,
    problemId,
    region: "us-east-1",
    awsAccountId: "123456789012",
    status: "PENDING",
    expiresAt: sourceEvent.expiresAt,
    score: 0,
    attempt: 1,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    stackName: deploymentStackName(sourceEvent.eventId, team.teamId, problemId),
    problemDir: `problems/challenges/${problemId}`,
    artifactDigest: contentDigest("synthetic-template"),
    connection: {
      eventId: sourceEvent.eventId,
      teamId: team.teamId,
      accountId: "123456789012",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/VerifiedFixtureRole",
      externalIdParameter: `arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/${sourceEvent.eventId}/${team.teamId}/external-id`,
      version: 1,
      verifiedAt: at,
    },
    scoring: { kind: "flag", points: 100, flagOutputKey: "Flag", wrongPenalty: 0 },
  };
}
function acceptance(
  job: DeploymentJob,
  team: TeamRecord,
  key = `deploy-${job.problemId}`,
  sourceEvent = event,
) {
  return {
    event: sourceEvent,
    team,
    job,
    requestKey: key,
    requestHash: contentDigest(JSON.stringify([job.problemId, team.teamId])),
    now,
  };
}
function completion(job: DeploymentJob) {
  return {
    status: "COMPLETE" as const,
    stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${job.stackName}/synthetic-id`,
    flagDigest: flagDigest(`flag-${job.jobId}`),
    publicOutputs: { WebsiteUrl: "https://synthetic.example.test" },
  };
}
async function acceptAndComplete(): Promise<void> {
  assert.equal(await repository().createEventWithTeams(event, teams), "created");
  await Promise.all(
    teams.map(async (team) => {
      const job = makeJob(team, 0);
      await work().saveVerifiedConnection(job.connection);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => work().accept(acceptance(job, team))),
      );
      assert.equal(results.filter((result) => result.kind === "accepted").length, 1);
      assert.equal(results.filter((result) => result.kind === "replay").length, 3);
      jobs.push(job);
    }),
  );
  assert.equal((await work().listDispatch(100)).length, 25);
  await Promise.all(
    jobs.map(async (job) => {
      assert.equal(await work().begin(job, `execution-${job.jobId}`, at), "started");
      assert.equal(await work().begin(job, `execution-${job.jobId}`, at), "replay");
      assert.equal(
        await work().finish(job, `execution-${job.jobId}`, completion(job), at),
        "updated",
      );
      assert.equal(
        await work().finish(job, `execution-${job.jobId}`, completion(job), at),
        "replay",
      );
    }),
  );
  assert.equal((await work().listDispatch()).length, 0);
  assert.equal(
    (await repository().listTeamScores(event.eventId)).every((row) => row.completedProblems === 0),
    true,
    "Deployment readiness must not count as a solved flag",
  );
}
async function scoreConcurrently(): Promise<void> {
  const started = performance.now();
  const results = await Promise.all(
    jobs.flatMap((job) => {
      const team = teams.find((candidate) => candidate.teamId === job.teamId);
      assert.ok(team);
      return Array.from({ length: 4 }, (_, index) =>
        work().submitFlag({
          event,
          team,
          jobId: job.jobId,
          attempt: 1,
          requestKey: `submission-${index}`,
          flag: `flag-${job.jobId}`,
          now,
        }),
      );
    }),
  );
  assert.equal(results.filter((result) => result.kind === "ok").length, 25);
  assert.equal(results.filter((result) => result.kind === "already_scored").length, 75);
  for (const job of jobs) {
    assert.equal((await work().getJob(job.jobId))?.score, 100);
    const ledger = await document.send(
      new QueryCommand({
        TableName: tables.deployments,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `DEPLOYMENT#${job.jobId}`, ":prefix": "EVENT#" },
      }),
    );
    assert.equal(ledger.Items?.length, 1);
    assert.equal(ledger.Items?.[0]?.points, 100);
  }
  const scores = await repository().listTeamScores(event.eventId);
  assert.equal(scores.length, 25);
  assert.equal(
    scores.reduce((sum, row) => sum + row.score, 0),
    2500,
  );
  assert.equal(
    scores.every((row) => row.completedProblems === 1),
    true,
  );
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-deploy-and-score",
      acceptedJobs: 25,
      submissions: 100,
      scoringWinners: 25,
      duplicateAwards: 0,
      ledgerEntries: 25,
      solvedProjection: "0 after deploy; 1 after first solve and repeated submissions",
      durationMs: Math.round(performance.now() - started),
    }),
  );
}
async function verifyRejections(): Promise<void> {
  const job = jobs[0];
  assert.ok(job);
  const team = teams.find((candidate) => candidate.teamId === job.teamId);
  assert.ok(team);
  const other = teams.find((candidate) => candidate.teamId !== job.teamId);
  assert.ok(other);
  const request = {
    event,
    team,
    jobId: job.jobId,
    attempt: 1,
    requestKey: "submission-0",
    flag: `flag-${job.jobId}`,
    now,
  };
  const replay = await work().submitFlag(request);
  assert.equal(replay.totalScore, 100);
  assert.equal(await work().finish(job, `execution-${job.jobId}`, completion(job), at), "replay");
  assert.equal(
    (await repository().listTeamScores(event.eventId)).find((row) => row.teamId === team.teamId)
      ?.completedProblems,
    1,
    "Neither a score receipt replay nor a late completion replay may count a solve twice",
  );
  await assert.rejects(
    () => work().submitFlag({ ...request, flag: "different-body" }),
    /idempotency_key_reused/u,
  );
  await assert.rejects(() => work().submitFlag({ ...request, team: other }), /scope_or_attempt/u);
  await assert.rejects(
    () => work().submitFlag({ ...request, event: { ...event, eventId: ulid() } }),
    /invalid_scoring_scope/u,
  );
  await assert.rejects(
    () => work().finish(job, "another-owner", { status: "FAILED", failureReason: "stale" }, at),
    /owner_changed/u,
  );
  await assert.rejects(
    () =>
      work().finish(
        job,
        `execution-${job.jobId}`,
        { status: "FAILED", failureReason: "late-failure" },
        at,
      ),
    /transition_conflict/u,
  );
  const fresh = randomBytes(32).toString("base64url");
  const race = await Promise.allSettled([
    work().submitFlag({ ...request, requestKey: "rotation-race" }),
    repository().rotateTeamAccess(team, fresh, at),
  ]);
  assert.equal(race[1]?.status, "fulfilled");
  assert.equal(await repository().authenticateTeam(team.teamLoginKey, now), undefined);
  await assert.rejects(() => work().submitFlag(request), /scope_or_access_changed/u);
  assert.equal((await work().getJob(job.jobId))?.score, 100);
  assert.equal(
    (await repository().listTeamScores(event.eventId)).find((row) => row.teamId === team.teamId)
      ?.score,
    100,
  );
  assert.equal(
    (await repository().listTeamScores(event.eventId)).find((row) => row.teamId === team.teamId)
      ?.completedProblems,
    1,
    "Key rotation cannot erase or duplicate solved-problem projection",
  );
  const updated = await repository().getTeam(team.eventId, team.teamId);
  assert.ok(updated);
  teams[teams.indexOf(team)] = updated;
  const failed = makeJob(updated, 19);
  await work().accept(acceptance(failed, updated));
  await work().begin(failed, "failed-owner", at);
  await work().finish(
    failed,
    "failed-owner",
    { status: "FAILED", failureReason: "synthetic CloudFormation failure" },
    at,
  );
  assert.equal(
    (await work().getJob(failed.jobId))?.failureReason,
    "synthetic CloudFormation failure",
  );
  const retried = { ...failed, attempt: 2 };
  await work().accept({ ...acceptance(retried, updated, "retry-failure"), retryOf: 1 });
  await assert.rejects(() => work().begin(failed, "stale-worker", at), /scope_or_attempt_changed/u);
  await assert.rejects(
    () =>
      work().submitFlag({
        ...request,
        team: updated,
        jobId: failed.jobId,
        requestKey: "stale-attempt",
      }),
    /scope_or_attempt_changed/u,
  );
  console.log(
    JSON.stringify({
      milestone: "durable-replay-and-ownership",
      retryAfterFailure: "passed",
      staleAttempt: "rejected",
      staleCompletion: "rejected",
      crossTeamAndEvent: "rejected",
      revokedKeyReplay: "rejected",
      rotationPreservedScoreProjection: "passed",
    }),
  );
}
const AUTH = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture",
  audience: "synthetic-organizer-client",
};
function httpApp() {
  return createCloudApp({
    repository: repository(),
    now: () => now,
    organizerAuth: AUTH,
    allowedOrigins: [],
    deployment: {
      work: work(),
      controlPlaneAccount: "123456789012",
      catalog: async () =>
        Object.fromEntries(
          event.problems.map((problem) => [
            problem.problemId,
            {
              problemId: problem.problemId,
              problemDir: `problems/challenges/${problem.problemId}`,
              artifactDigest: contentDigest("synthetic-template"),
              catalogKey: "catalogs/synthetic.json",
              scoring: {
                kind: "flag" as const,
                points: 100,
                flagOutputKey: "Flag",
                wrongPenalty: 0,
              },
              parameters: {},
            },
          ]),
        ),
    },
  });
}
function organizerRequest(data: unknown, key: string, role = "Admin") {
  return httpApp().request(
    `/events/${event.eventId}/deploy`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(data),
    },
    {
      event: {
        requestContext: {
          authorizer: {
            claims: {
              sub: "synthetic-organizer",
              iss: AUTH.issuer,
              aud: AUTH.audience,
              exp: now / 1000 + 3600,
              token_use: "id",
              "custom:userRole": role,
            },
          },
        },
      },
    },
  );
}
async function verifyHttpDeployment(): Promise<void> {
  assert.equal((await organizerRequest({}, "viewer-denied", "Viewer")).status, 403);
  const response = await organizerRequest({}, "fill-twenty-problems");
  assert.equal(response.status, 202, await response.clone().text());
  const first = await response.json();
  const replay = await organizerRequest({}, "fill-twenty-problems");
  assert.equal(replay.status, 202, await replay.clone().text());
  assert.deepEqual(await replay.json(), first);
  assert.equal(
    (await organizerRequest({ problemIds: ["problem-0"] }, "fill-twenty-problems")).status,
    422,
  );
  const pending = await work().listDispatch(1000);
  for (let offset = 0; offset < pending.length; offset += 25) {
    await Promise.all(
      pending.slice(offset, offset + 25).map(async (intent) => {
        const job = await work().getJob(intent.jobId);
        assert.ok(job);
        const owner = `workflow-${job.jobId}-${job.attempt}`;
        await work().begin(job, owner, at);
        await work().finish(job, owner, completion(job), at);
      }),
    );
  }
  const allJobs = await repository().listDeploymentsByEvent(event.eventId);
  assert.equal(allJobs.length, 500);
  assert.equal(
    allJobs.every((job) => job.status === "COMPLETE"),
    true,
  );
  const scores = await repository().listTeamScores(event.eventId);
  assert.equal(
    scores.every((score) => score.completedProblems === 1),
    true,
  );
  const scoring = await Promise.all(
    teams.flatMap((team) =>
      Array.from({ length: 4 }, async (_, index) => {
        const job = await work().getTarget(team.eventId, team.teamId, "problem-1");
        assert.ok(job);
        const response = await httpApp().request("/portal/me/submit-flag", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${team.teamLoginKey}`,
            "content-type": "application/json",
            "Idempotency-Key": `http-submission-${index}`,
          },
          body: JSON.stringify({ problemId: "problem-1", flag: `flag-${job.jobId}` }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return z
          .object({ kind: z.string() })
          .passthrough()
          .parse(await response.json());
      }),
    ),
  );
  assert.equal(scoring.filter((result) => result.kind === "ok").length, 25);
  assert.equal(
    (await repository().listTeamScores(event.eventId)).reduce((sum, score) => sum + score.score, 0),
    5000,
  );
  console.log(
    JSON.stringify({
      milestone: "http-deploy-and-flag",
      jobs: allJobs.length,
      problemsPerTeam: 20,
      simultaneousSubmissions: 100,
      winners: 25,
      batchReplay: "identical",
      batchKeyDifferentBody: "rejected",
      viewerDeploy: "rejected",
    }),
  );
}
async function verifyRealPolling(): Promise<void> {
  assert.equal(POLL_INTERVAL_MS, 30_000);
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    metrics = { commands: 0, queryRows: 0, pointReads: 0, eventWideDeploymentQueries: 0 };
    const latencies: number[] = [];
    const started = performance.now();
    measuring = true;
    await Promise.all(
      teams.flatMap((team) =>
        Array.from({ length: 4 }, async () => {
          const browserStarted = performance.now();
          const headers = { Authorization: `Bearer ${team.teamLoginKey}` };
          const [me, leaderboard] = await Promise.all([
            httpApp().request("/portal/me", { headers }),
            httpApp().request("/portal/leaderboard", { headers }),
          ]);
          assert.equal(me.status, 200);
          assert.equal(leaderboard.status, 200);
          const view = z
            .object({ problems: z.array(z.object({ problemId: z.string() }).passthrough()) })
            .passthrough()
            .parse(await me.json());
          const board = z
            .object({
              entries: z.array(
                z.object({ score: z.number(), completedProblems: z.number() }).passthrough(),
              ),
            })
            .passthrough()
            .parse(await leaderboard.json());
          assert.equal(view.problems.length, 20);
          assert.equal(board.entries.length, 25);
          assert.equal(
            board.entries.every((entry) => entry.completedProblems === 2),
            true,
          );
          assert.equal(
            board.entries.reduce((sum, entry) => sum + entry.score, 0),
            5000,
          );
          latencies.push(performance.now() - browserStarted);
        }),
      ),
    );
    measuring = false;
    latencies.sort((a, b) => a - b);
    assert.equal(metrics.queryRows, 7000);
    assert.equal(metrics.pointReads, 700);
    assert.equal(metrics.eventWideDeploymentQueries, 0);
    rounds.push({
      round,
      durationMs: Math.round(performance.now() - started),
      p50Ms: Math.round(latencies[49] ?? 0),
      p95Ms: Math.round(latencies[94] ?? 0),
      ...metrics,
    });
  }
  console.log(
    JSON.stringify({
      milestone: "real-portal-polling",
      participants: 100,
      teams: 25,
      problemsPerTeam: 20,
      pollingIntervalMs: POLL_INTERVAL_MS,
      scope:
        "current opt-in me+leaderboard polling, actual local SDK I/O; not AWS latency/RCU capacity",
      rounds,
    }),
  );
}
async function verifyActualClientContracts(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let loseNextFlagResponse = false;
  const observedKeys: string[] = [];
  const fetchThroughApi = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://cloud-fixture.test")
      throw new Error("Synthetic client test refuses external fetch.");
    const key = request.headers.get("Idempotency-Key");
    if (key) observedKeys.push(key);
    const gateway =
      request.headers.get("Authorization") === "Bearer synthetic-id-token"
        ? {
            event: {
              requestContext: {
                authorizer: {
                  claims: {
                    sub: "client-organizer",
                    iss: AUTH.issuer,
                    aud: AUTH.audience,
                    token_use: "id",
                    exp: now / 1000 + 3600,
                    "custom:userRole": "Admin",
                  },
                },
              },
            },
          }
        : undefined;
    const response = await httpApp().request(request, undefined, gateway);
    if (loseNextFlagResponse && url.pathname === "/portal/me/submit-flag") {
      loseNextFlagResponse = false;
      throw new TypeError("Synthetic response loss after the durable transaction");
    }
    return response;
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchThroughApi,
  });
  try {
    const api = createCoreApiClient("https://cloud-fixture.test", "synthetic-id-token");
    const createBody = {
      name: "Actual client contract",
      teams: [{ internalSlug: "client-team" }],
      problems: event.problems.slice(0, 1),
    };
    const created = await clientCreateEvent(api, createBody, "client-create-operation");
    const replay = await clientCreateEvent(api, createBody, "client-create-operation");
    assert.deepEqual(replay, created);
    assert.notEqual(
      (await clientCreateEvent(api, createBody, "client-create-next-operation")).eventId,
      created.eventId,
    );
    await assert.rejects(
      () =>
        clientCreateEvent(
          api,
          { ...createBody, name: "Different body" },
          "client-create-operation",
        ),
      /idempotency_key_reused/u,
    );
    const bulk = await clientBulkDeploy(api, event.eventId, {}, "client-bulk-operation");
    assert.deepEqual(await clientBulkDeploy(api, event.eventId, {}, "client-bulk-operation"), bulk);
    const team = teams[1];
    assert.ok(team);
    const job = await work().getTarget(team.eventId, team.teamId, "problem-2");
    assert.ok(job);
    // Synthetic existing earned points let the test observe the hello-world explicit zero floor.
    await document.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tables.deployments,
              Key: { PK: `DEPLOYMENT#${job.jobId}`, SK: "META" },
              UpdateExpression: "SET score = :score, scoring.wrongPenalty = :penalty",
              ExpressionAttributeValues: { ":score": 20, ":penalty": 5 },
            },
          },
          {
            Update: {
              TableName: tables.teams,
              Key: { PK: `EVENT#${event.eventId}`, SK: `SCORE#${team.teamId}` },
              UpdateExpression: "ADD score :score",
              ExpressionAttributeValues: { ":score": 20 },
            },
          },
          {
            Put: {
              TableName: tables.deployments,
              Item: { PK: `DEPLOYMENT#${job.jobId}`, SK: "EVENT#synthetic-seed", points: 20 },
            },
          },
        ],
      }),
    );
    loseNextFlagResponse = true;
    const submit = (key: string, flag = "intentional wrong flag") =>
      clientSubmitFlag(
        "https://cloud-fixture.test",
        team.teamLoginKey,
        "problem-2",
        flag,
        undefined,
        undefined,
        key,
      );
    await assert.rejects(() => submit("client-flag-operation"));
    assert.equal((await work().getJob(job.jobId))?.score, 15);
    assert.deepEqual(await submit("client-flag-operation"), {
      kind: "wrong",
      scoreDelta: -5,
      totalScore: 15,
    });
    assert.equal((await work().getJob(job.jobId))?.score, 15);
    assert.deepEqual(await submit("client-flag-next-operation"), {
      kind: "wrong",
      scoreDelta: -5,
      totalScore: 10,
    });
    await assert.rejects(
      () => submit("client-flag-operation", "changed body"),
      (error: unknown) =>
        error instanceof Error &&
        "errorCode" in error &&
        error.errorCode === "idempotency_key_reused",
    );
    assert.equal((await work().getJob(job.jobId))?.score, 10);
    assert.ok(observedKeys.filter((key) => key === "client-flag-operation").length >= 3);
    console.log(
      JSON.stringify({
        milestone: "actual-spa-client-contract",
        createReplay: "identical",
        intentionalNewCreate: "distinct event",
        bulkReplay: "identical",
        wrongFlagNetworkLossReplay: "one -5 deduction",
        intentionalSameWrongFlagResubmit: "second -5 deduction",
        changedBodySameKey: "422",
        realClientKeysObserved: observedKeys.length,
      }),
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
}
async function verifyRollbackAndGate(): Promise<void> {
  const team = teams[3];
  assert.ok(team);
  const job = await work().getTarget(team.eventId, team.teamId, "problem-4");
  assert.ok(job);
  const key = "synthetic-ledger-collision";
  const ledgerKey = { PK: `DEPLOYMENT#${job.jobId}`, SK: `EVENT#${contentDigest(key)}` };
  await document.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tables.deployments, Item: { ...ledgerKey, points: 999 } } },
      ],
    }),
  );
  const request = {
    event,
    team,
    jobId: job.jobId,
    attempt: job.attempt,
    requestKey: key,
    flag: `flag-${job.jobId}`,
    now,
  };
  await assert.rejects(() => work().submitFlag(request), /scope_or_access_changed/u);
  assert.equal((await work().getJob(job.jobId))?.score, 0);
  const receipt = await document.send(
    new GetCommand({
      TableName: tables.deployments,
      ConsistentRead: true,
      Key: {
        PK: `EVENT#${event.eventId}#TEAM#${team.teamId}`,
        SK: `RECEIPT#FLAG#${contentDigest(key)}`,
      },
    }),
  );
  assert.equal(receipt.Item, undefined);
  assert.equal(
    (await repository().listTeamScores(event.eventId)).find((score) => score.teamId === team.teamId)
      ?.score,
    200,
  );
  await document.send(
    new TransactWriteCommand({
      TransactItems: [{ Delete: { TableName: tables.deployments, Key: ledgerKey } }],
    }),
  );
  await work().setSchedule(event, { scoringLocked: true }, new Date(now + 1).toISOString());
  await assert.rejects(
    () => work().submitFlag({ ...request, requestKey: "stale-unlocked-snapshot" }),
    /scope_or_access_changed/u,
  );
  const locked = await repository().getEvent(event.eventId);
  assert.ok(locked);
  await assert.rejects(
    () => work().submitFlag({ ...request, event: locked, requestKey: "locked-request" }),
    /scoring_locked/u,
  );
  assert.equal((await work().getJob(job.jobId))?.score, 0);
  console.log(
    JSON.stringify({
      milestone: "transaction-rollback-and-event-fence",
      forcedLedgerCollision: "rolled back score and receipt and projection",
      staleUnlockedSnapshot: "rejected at commit",
      lockedEvent: "rejected",
    }),
  );
}

function teardownRequest(eventId: string, role = "Admin") {
  return httpApp().request(
    `/events/${eventId}`,
    { method: "DELETE" },
    {
      event: {
        requestContext: {
          authorizer: {
            claims: {
              sub: "synthetic-teardown-organizer",
              iss: AUTH.issuer,
              aud: AUTH.audience,
              exp: now / 1000 + 3600,
              token_use: "id",
              "custom:userRole": role,
            },
          },
        },
      },
    },
  );
}
function deletionIdentity(job: DeploymentJob, generation = 1): DeploymentIdentity {
  return {
    eventId: job.eventId,
    teamId: job.teamId,
    jobId: job.jobId,
    attempt: job.attempt,
    operation: "delete",
    generation,
  };
}
function syntheticReference(job: DeploymentJob) {
  return {
    stackId: completion(job).stackId,
    fingerprint: contentDigest(`synthetic-immutable-input-${job.jobId}`),
  };
}
async function partitionRows(PK: string) {
  const output = await document.send(
    new QueryCommand({
      TableName: tables.deployments,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": PK },
    }),
  );
  assert.equal(
    output.LastEvaluatedKey,
    undefined,
    "Synthetic preservation snapshot must not truncate",
  );
  return output.Items ?? [];
}
async function retainedDeploymentHistory(targets: readonly DeploymentJob[]) {
  return Promise.all(
    targets.map(async (job) => ({
      jobId: job.jobId,
      rows: (await partitionRows(`DEPLOYMENT#${job.jobId}`)).filter(
        (row) => row.SK !== "META" && row.SK !== "TEARDOWN",
      ),
    })),
  );
}
async function retainedReceipts(eventId: string, members: readonly TeamRecord[]) {
  return Promise.all(
    members.map(async (team) => ({
      teamId: team.teamId,
      rows: (await partitionRows(`EVENT#${eventId}#TEAM#${team.teamId}`)).filter(
        (row) => typeof row.SK === "string" && row.SK.startsWith("RECEIPT#"),
      ),
    })),
  );
}
async function assertTeardownEvent(
  eventId: string,
  status: "TEARDOWN" | "ARCHIVED",
  completed: number,
  expected = 28,
) {
  const current = await repository().getEvent(eventId);
  assert.ok(current);
  assert.equal(current.status, status);
  assert.equal(current.scoringLocked, true);
  assert.equal(current.teardownExpected, expected);
  assert.equal(current.teardownCompleted, completed);
}
async function verifyEventTeardown(): Promise<void> {
  const started = performance.now();
  const closing: EventRecord = {
    ...event,
    eventId: ulid(),
    name: "Synthetic durable event teardown acceptance",
    problems: event.problems.slice(0, 3),
  };
  const members = teams.map(
    (team, index): TeamRecord => ({
      ...team,
      eventId: closing.eventId,
      teamId: ulid(),
      internalSlug: `teardown-team-${index}`,
      teamLoginKey: randomBytes(32).toString("base64url"),
    }),
  );
  assert.equal(await repository().createEventWithTeams(closing, members), "created");
  const completeJobs = await Promise.all(
    members.map(async (team) => {
      const job = makeJob(team, 0, closing);
      await work().saveVerifiedConnection(job.connection);
      assert.equal(
        (await work().accept(acceptance(job, team, "teardown-deploy", closing))).kind,
        "accepted",
      );
      assert.equal((await work().getCreation(job))?.state, "NOT_STARTED");
      const owner = `source-${job.jobId}`;
      assert.equal(await work().begin(job, owner, at), "started");
      await work().reserveCreation(job, owner, now);
      assert.equal((await work().getCreation(job))?.state, "REQUESTED");
      await work().recordCreation(job, owner, syntheticReference(job));
      assert.equal((await work().getCreation(job))?.state, "ACKNOWLEDGED");
      assert.equal(await work().finish(job, owner, completion(job), at), "updated");
      assert.equal(
        (
          await work().submitFlag({
            event: closing,
            team,
            jobId: job.jobId,
            attempt: job.attempt,
            requestKey: "teardown-scored",
            flag: `flag-${job.jobId}`,
            now,
          })
        ).kind,
        "ok",
      );
      return job;
    }),
  );
  const first = members[0];
  const second = members[1];
  const third = members[2];
  assert.ok(first && second && third);
  const pending = makeJob(first, 1, closing);
  const unreserved = makeJob(second, 1, closing);
  const uncertain = makeJob(third, 1, closing);
  for (const [job, team] of [
    [pending, first],
    [unreserved, second],
    [uncertain, third],
  ] as const) {
    assert.equal(
      (await work().accept(acceptance(job, team, "teardown-extra", closing))).kind,
      "accepted",
    );
  }
  await work().begin(unreserved, "unreserved-source", at);
  await work().begin(uncertain, "uncertain-source", at);
  await work().reserveCreation(uncertain, "uncertain-source", now);
  assert.equal((await work().getCreation(unreserved))?.state, "NOT_STARTED");
  assert.equal((await work().getCreation(uncertain))?.state, "REQUESTED");
  assert.equal((await work().getCreation(uncertain))?.stackId, undefined);
  const all = [...completeJobs, pending, unreserved, uncertain];
  const scoresBefore = await repository().listTeamScores(closing.eventId);
  const historyBefore = await retainedDeploymentHistory(all);
  const receiptsBefore = await retainedReceipts(closing.eventId, members);
  assert.equal(
    scoresBefore.reduce((sum, row) => sum + row.score, 0),
    2500,
  );
  assert.equal(
    historyBefore
      .flatMap((entry) => entry.rows)
      .filter((row) => typeof row.SK === "string" && row.SK.startsWith("EVENT#")).length,
    25,
  );
  assert.equal(receiptsBefore.flatMap((entry) => entry.rows).length, 53);

  let strongTargetQueries = 0;
  document.middlewareStack.add(
    (next) => async (args) => {
      const input = z
        .object({
          TableName: z.string().optional(),
          IndexName: z.string().optional(),
          ConsistentRead: z.boolean().optional(),
          ExpressionAttributeValues: z.record(z.unknown()).optional(),
        })
        .passthrough()
        .parse(args.input);
      if (
        input.TableName === tables.deployments &&
        input.ExpressionAttributeValues?.[":prefix"] === "TARGET#"
      ) {
        assert.equal(
          input.ConsistentRead,
          true,
          "Teardown must enumerate authoritative base-table TARGET rows",
        );
        assert.equal(
          input.IndexName,
          undefined,
          "An eventually consistent index cannot prove all targets are gone",
        );
        strongTargetQueries++;
      }
      return next(args);
    },
    { step: "initialize", name: "syntheticTeardownTargetConsistency" },
  );
  try {
    assert.equal((await teardownRequest(closing.eventId, "Viewer")).status, 403);
    assert.equal((await repository().getEvent(closing.eventId))?.status, "DRAFT");
    const deleted = await teardownRequest(closing.eventId);
    assert.equal(deleted.status, 202, await deleted.clone().text());
    assert.deepEqual(await deleted.json(), {
      eventId: closing.eventId,
      enqueued: 28,
      skipped: 0,
      failed: 0,
    });
    assert.ok(strongTargetQueries >= 25);
    const repeated = await teardownRequest(closing.eventId);
    assert.equal(repeated.status, 202, await repeated.clone().text());
    assert.deepEqual(await repeated.json(), {
      eventId: closing.eventId,
      enqueued: 0,
      skipped: 28,
      failed: 0,
    });
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 1);
    assert.equal(await work().closeEvent(closing, at), "closing");
    assert.equal(await work().archiveTeardown(closing.eventId), false);
    await assert.rejects(
      () => work().setTeardownExpected(closing.eventId, 27),
      /teardown_target_set_changed/u,
    );
    assert.equal((await work().getJob(pending.jobId))?.status, "DELETED");
    assert.equal((await work().getCreation(pending))?.state, "NOT_STARTED");
    assert.equal((await work().getTeardown(pending))?.status, "DELETED");
    assert.equal(
      (await work().listDispatch(1000)).some((intent) => intent.jobId === pending.jobId),
      false,
    );
    assert.equal(await work().requestTeardown(pending, at), "skipped");
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 1);

    const blocked = makeJob(first, 2, closing);
    await assert.rejects(
      () => work().accept(acceptance(blocked, first, "closed-new-work", closing)),
      /deployment_acceptance_conflict/u,
    );
    assert.equal(await work().getJob(blocked.jobId), undefined);
    await assert.rejects(
      () => work().reserveCreation(unreserved, "unreserved-source", now),
      /creation_closed_or_owner_changed/u,
    );
    await assert.rejects(
      () => work().reserveCreation(uncertain, "uncertain-source", now + 120_001),
      /creation_closed_or_owner_changed/u,
    );
    assert.equal((await work().getCreation(unreserved))?.state, "NOT_STARTED");
    assert.equal((await work().getCreation(uncertain))?.state, "REQUESTED");

    const unknownDelete = deletionIdentity(uncertain);
    const unreservedDelete = deletionIdentity(unreserved);
    await work().beginTeardown(unreservedDelete, "unreserved-delete", at);
    await work().beginTeardown(unknownDelete, "uncertain-delete-1", at);
    for (const instant of [now, now + 120_001]) {
      assert.equal(
        await work().prepareDeletion(unreservedDelete, "unreserved-delete", instant),
        false,
      );
      assert.equal(
        await work().prepareDeletion(unknownDelete, "uncertain-delete-1", instant),
        false,
      );
    }
    await assert.rejects(
      () => work().finishTeardown(unknownDelete, "uncertain-delete-1", { status: "DELETED" }, at),
      /teardown_not_deleting/u,
    );
    assert.equal((await work().getJob(uncertain.jobId))?.status, "IN_PROGRESS");
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 1);
    await work().finish(
      unreserved,
      "unreserved-source",
      { status: "FAILED", failureReason: "synthetic source stopped before create" },
      at,
    );
    assert.equal(await work().prepareDeletion(unreservedDelete, "unreserved-delete", now), true);
    assert.equal(
      await work().finishTeardown(unreservedDelete, "unreserved-delete", { status: "DELETED" }, at),
      "updated",
    );
    assert.equal(
      await work().finishTeardown(unreservedDelete, "unreserved-delete", { status: "DELETED" }, at),
      "replay",
    );
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 2);
    await work().finish(
      uncertain,
      "uncertain-source",
      { status: "FAILED", failureReason: "synthetic CreateStack response loss" },
      at,
    );
    assert.equal(await work().prepareDeletion(unknownDelete, "uncertain-delete-1", now), false);
    assert.equal(
      await work().prepareDeletion(unknownDelete, "uncertain-delete-1", now + 120_001),
      true,
    );
    assert.equal((await work().getCreation(uncertain))?.state, "REQUESTED");
    assert.equal((await work().getCreation(uncertain))?.stackId, undefined);
    assert.equal((await work().getJob(uncertain.jobId))?.status, "DELETING");
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 2);
    const discovered = syntheticReference(uncertain);
    await work().recordTeardownReference(unknownDelete, "uncertain-delete-1", discovered);
    await work().recordTeardownReference(unknownDelete, "uncertain-delete-1", discovered);
    await assert.rejects(
      () =>
        work().recordTeardownReference(unknownDelete, "uncertain-delete-1", {
          ...discovered,
          stackId: `${discovered.stackId}-replacement`,
        }),
      /teardown_reference_changed/u,
    );
    assert.equal(
      await work().finishTeardown(
        unknownDelete,
        "uncertain-delete-1",
        { status: "FAILED", failureReason: "synthetic DELETE_FAILED: retained resource" },
        at,
      ),
      "updated",
    );
    assert.equal((await work().getJob(uncertain.jobId))?.teardownStatus, "FAILED");
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 2);

    const retry = await teardownRequest(closing.eventId);
    assert.equal(retry.status, 202, await retry.clone().text());
    assert.deepEqual(await retry.json(), {
      eventId: closing.eventId,
      enqueued: 1,
      skipped: 27,
      failed: 0,
    });
    const retried = deletionIdentity(uncertain, 2);
    const marker = await work().getTeardown(retried);
    assert.equal(marker?.generation, 2);
    assert.equal(
      marker?.stackId,
      discovered.stackId,
      "Retry must retain the discovered physical stack identity",
    );
    assert.equal(marker?.fingerprint, discovered.fingerprint);
    assert.equal(await work().beginTeardown(retried, "uncertain-delete-2", at), "started");
    assert.equal(await work().beginTeardown(retried, "uncertain-delete-2", at), "replay");
    assert.equal(await work().prepareDeletion(retried, "uncertain-delete-2", now + 120_001), true);
    await assert.rejects(
      () => work().finishTeardown(unknownDelete, "uncertain-delete-1", { status: "DELETED" }, at),
      /teardown_scope_or_generation_changed/u,
    );
    await assert.rejects(
      () => work().finishTeardown(retried, "uncertain-delete-1", { status: "DELETED" }, at),
      /teardown_owner_changed/u,
    );
    await assert.rejects(
      () =>
        work().finishTeardown(
          { ...retried, attempt: 2 },
          "uncertain-delete-2",
          { status: "DELETED" },
          at,
        ),
      /teardown_scope_or_generation_changed/u,
    );

    const prepared = await Promise.all(
      completeJobs.map(async (job) => {
        const identity = deletionIdentity(job);
        const owner = `terminal-delete-${job.jobId}`;
        assert.equal(await work().beginTeardown(identity, owner, at), "started");
        assert.equal(
          await work().prepareDeletion(identity, owner, now),
          false,
          "A live create lease must remain fenced",
        );
        assert.equal(await work().prepareDeletion(identity, owner, now + 120_001), true);
        await work().recordTeardownReference(identity, owner, syntheticReference(job));
        return { job, identity, owner };
      }),
    );
    const finished = await Promise.all(
      prepared.map(({ identity, owner, job }) =>
        work().finishTeardown(
          identity,
          owner,
          { status: "DELETED", stackId: completion(job).stackId },
          at,
        ),
      ),
    );
    assert.equal(finished.filter((result) => result === "updated").length, 25);
    assert.equal(
      (
        await Promise.all(
          prepared.map(({ identity, owner, job }) =>
            work().finishTeardown(
              identity,
              owner,
              { status: "DELETED", stackId: completion(job).stackId },
              at,
            ),
          ),
        )
      ).every((result) => result === "replay"),
      true,
    );
    await assertTeardownEvent(closing.eventId, "TEARDOWN", 27);
    assert.equal(await work().archiveTeardown(closing.eventId), false);
    assert.equal(
      await work().finishTeardown(
        retried,
        "uncertain-delete-2",
        { status: "DELETED", stackId: discovered.stackId },
        at,
      ),
      "updated",
    );
    assert.equal(
      await work().finishTeardown(
        retried,
        "uncertain-delete-2",
        { status: "DELETED", stackId: discovered.stackId },
        at,
      ),
      "replay",
    );
    await assertTeardownEvent(closing.eventId, "ARCHIVED", 28);
    const archived = await teardownRequest(closing.eventId);
    assert.equal(archived.status, 200, await archived.clone().text());
    assert.deepEqual(await archived.json(), {
      eventId: closing.eventId,
      enqueued: 0,
      skipped: 28,
      failed: 0,
    });
    await assertTeardownEvent(closing.eventId, "ARCHIVED", 28);
    assert.equal(
      (await work().listDispatch(1000)).some((intent) => intent.eventId === closing.eventId),
      false,
    );
    assert.deepEqual(await repository().listTeamScores(closing.eventId), scoresBefore);
    assert.deepEqual(await retainedDeploymentHistory(all), historyBefore);
    assert.deepEqual(await retainedReceipts(closing.eventId, members), receiptsBefore);
    for (const job of completeJobs) {
      const saved = await work().getJob(job.jobId);
      assert.equal(saved?.status, "DELETED");
      assert.equal(saved?.score, 100);
      assert.equal(saved?.flagDigest, completion(job).flagDigest);
      assert.deepEqual(saved?.publicOutputs, completion(job).publicOutputs);
      assert.equal(saved?.flagSubmitted, true);
    }
    console.log(
      JSON.stringify({
        milestone: "durable-event-teardown",
        teams: 25,
        targets: 28,
        concurrentTerminalFinishes: 25,
        strongTargetQueries,
        pendingCancellation: "counted once, original dispatch removed",
        createStates: "NOT_STARTED, REQUESTED, ACKNOWLEDGED preserved",
        createAndExpiredLeaseFence: "passed",
        httpDeleteReplayAndPartialFailure: "passed",
        retryGenerationAndDurableReference:
          "preserved; stale owner, generation and attempt rejected",
        eventCompletion: "28 unique targets; archive only after final target",
        retainedScores: 2500,
        retainedScoreLedgerEntries: 25,
        retainedReceipts: 53,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    document.middlewareStack.remove("syntheticTeardownTargetConsistency");
  }
}

async function verifyHistoricalTeardownBlocker(): Promise<void> {
  for (const mode of ["recorded-old-account", "uncertain-create", "never-started"] as const) {
    const sourceEvent: EventRecord = {
      ...event,
      eventId: ulid(),
      name: `Synthetic history ${mode}`,
      teamCount: 1,
      problems: event.problems.slice(0, 1),
    };
    const base = teams[0];
    assert.ok(base);
    const team: TeamRecord = {
      ...base,
      eventId: sourceEvent.eventId,
      teamId: ulid(),
      teamLoginKey: randomBytes(32).toString("base64url"),
    };
    assert.equal(await repository().createEventWithTeams(sourceEvent, [team]), "created");
    const original = makeJob(team, 0, sourceEvent);
    await work().saveVerifiedConnection(original.connection);
    await work().accept(acceptance(original, team, "history-first", sourceEvent));
    await work().begin(original, "history-source", at);
    if (mode !== "never-started") await work().reserveCreation(original, "history-source", now);
    if (mode === "recorded-old-account")
      await work().recordCreation(original, "history-source", syntheticReference(original));
    await work().finish(
      original,
      "history-source",
      {
        status: "FAILED",
        failureReason: "synthetic source failed",
        ...(mode === "recorded-old-account" ? { stackId: completion(original).stackId } : {}),
      },
      at,
    );
    const replacement = makeJob(team, 0, sourceEvent);
    await assert.rejects(
      () => work().accept(acceptance(replacement, team, "illegal-new-job", sourceEvent)),
      /deployment_acceptance_conflict/u,
    );
    assert.equal(
      await work().getJob(replacement.jobId),
      undefined,
      "An existing target cannot be replaced with a different job ID",
    );
    let retry: DeploymentJob = { ...original, attempt: 2 };
    if (mode === "recorded-old-account") {
      const connection = {
        ...original.connection,
        accountId: "999999999999",
        roleArn: "arn:aws:iam::999999999999:role/VerifiedFixtureRole",
        version: 2,
      };
      await work().saveVerifiedConnection(connection, 1);
      retry = { ...retry, awsAccountId: connection.accountId, connection };
    }
    await work().accept({ ...acceptance(retry, team, "history-retry", sourceEvent), retryOf: 1 });
    assert.equal(
      retry.stackName,
      original.stackName,
      "Logical names are stable but account changes still identify different physical stacks",
    );
    if (mode === "uncertain-create")
      await document.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tables.deployments,
                Key: { PK: `DEPLOYMENT#${original.jobId}`, SK: "CREATE#1" },
                UpdateExpression: "SET leaseUntil = :expired",
                ExpressionAttributeValues: { ":expired": now - 1 },
              },
            },
          ],
        }),
      );
    const response = await teardownRequest(sourceEvent.eventId);
    const saved = await repository().getEvent(sourceEvent.eventId);
    assert.ok(saved);
    if (mode === "never-started") {
      assert.equal(response.status, 202, await response.clone().text());
      assert.equal(saved.status, "ARCHIVED");
      assert.equal(saved.teardownCompleted, 1);
    } else {
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(await response.json(), { error: "historical_attempt_resources_unresolved" });
      assert.equal(saved.status, "TEARDOWN");
      assert.equal(saved.teardownExpected, undefined);
      assert.equal(saved.teardownCompleted, 0);
      assert.equal(await work().archiveTeardown(sourceEvent.eventId), false);
      assert.equal(
        await work().getTeardown(retry),
        undefined,
        "No current-target cleanup is enqueued after an unresolved history blocker",
      );
      assert.equal((await work().getJob(retry.jobId))?.status, "PENDING");
    }
  }
  console.log(
    JSON.stringify({
      milestone: "historical-attempt-teardown-boundary",
      oldAccountArn: "blocks before any teardown acceptance or archive",
      expiredUncertainCreate: "blocks",
      provenNeverStarted: "may complete",
      newJobTargetReplacement: "rejected",
    }),
  );
}

try {
  await createTables();
  await acceptAndComplete();
  await scoreConcurrently();
  await verifyRejections();
  await verifyHttpDeployment();
  await verifyRealPolling();
  await verifyActualClientContracts();
  await verifyRollbackAndGate();
  await verifyEventTeardown();
  await verifyHistoricalTeardownBlocker();
  console.log(
    JSON.stringify({
      outcome: "passed",
      target: "official DynamoDB Local, synthetic work, no AWS execution",
    }),
  );
} finally {
  try {
    for (const TableName of createdTables) await client.send(new DeleteTableCommand({ TableName }));
  } finally {
    client.destroy();
  }
}
