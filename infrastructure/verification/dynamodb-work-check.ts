/** Explicit local-only acceptance. Uses official DynamoDB Local, never AWS or ambient credentials. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { z } from "zod";
import {
  bulkCreateCompetitorAccounts,
  createCompetitorAccount,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  verifyCompetitorAccount,
} from "../../apps/application-admin-console/src/api/competitor-accounts-client.js";
import {
  bulkDeployEvent as clientBulkDeploy,
  bulkTeardownEvent as clientBulkTeardown,
  createEvent as clientCreateEvent,
} from "../../apps/application-admin-console/src/api/events-client.js";
import { submitCoordinationOp as clientCoordinationOp } from "../../apps/participant-portal/src/api/coordination-client.js";
import { submitFlag as clientSubmitFlag } from "../../apps/participant-portal/src/api/portal-client/scoring.js";
import { POLL_INTERVAL_MS } from "../../apps/participant-portal/src/constants/polling.js";
import { type CoreApiClient, createCoreApiClient } from "../../packages/web-kit/src/api-client.js";
import type { HostPlugin } from "../../scripts/local-host/coordination-core.js";
import { nativeBattleArtifact } from "../lib/cloud-hosting/execution-artifacts.js";
import type { CompetitorAccountRecord } from "../lib/problem-deploy/control-data/domain/competitor-accounts.js";
import {
  coordinationHeadKey,
  type NativeCoordinationArtifact,
} from "../lib/problem-deploy/control-data/domain/coordination.js";
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
import { DynamoDbCompetitorAccountsRepository } from "../lib/problem-deploy/control-data/dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import {
  type CoordinationWriteMeasurement,
  DynamoDeploymentsCoordination,
} from "../lib/problem-deploy/control-data/dynamodb-deployments-coordination.js";
import { createCloudApp } from "../lib/problem-deploy/handlers/cloud-api/app.js";
import { createRegisteredConnectionPreparer } from "../lib/problem-deploy/handlers/cloud-api/connection-routes.js";
import type { NativeProblem } from "../lib/problem-deploy/handlers/cloud-api/execution-config.js";
import type { CloudParticipantAccess } from "../lib/problem-deploy/handlers/cloud-api/participant-access.js";
import {
  dispatchExecutionName,
  dispatchPending,
} from "../lib/problem-deploy/handlers/cloud-runner/dispatcher.js";
import {
  deploymentIdentity,
  deploymentOwnershipTags,
} from "../lib/problem-deploy/handlers/cloud-runner/index.js";
import {
  buildDeploymentInput,
  serializeDispatchIdentity,
} from "../lib/problem-deploy/handlers/cloud-runner/workflow.js";

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
let nativeCapacityMet = true;
async function createTables(names = tables): Promise<void> {
  for (const [kind, TableName] of Object.entries(names)) {
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

async function verifyHistoricalTeardownCase(
  mode: "recorded-old-account" | "uncertain-create" | "never-started",
): Promise<void> {
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
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal(saved.status, "TEARDOWN");
  assert.equal(saved.teardownExpected, 1);
  assert.equal(saved.teardownCompleted, 0);
  if (mode !== "never-started") {
    assert.equal(
      (await work().listDispatch(1000)).some(
        (item) => item.jobId === retry.jobId && item.attempt === 2 && item.operation === "delete",
      ),
      false,
      "A historical blocker must keep the current root out of the old-worker dispatch queue",
    );
    const identity = deletionIdentity(original);
    await work().beginTeardown(identity, "history-delete", at);
    assert.equal(await work().prepareDeletion(identity, "history-delete", now + 120_001), true);
    assert.deepEqual((await work().getDeletionJob(identity)).job.connection, original.connection);
    if (mode === "uncertain-create") {
      await assert.rejects(
        () => work().finishTeardown(identity, "history-delete", { status: "DELETED" }, at),
        /teardown_absence_unconfirmed/u,
      );
      assert.equal((await work().getTeardown(retry))?.historyCompleted, 0);
    }
    await work().recordTeardownReference(identity, "history-delete", syntheticReference(original));
    await work().finishTeardown(
      identity,
      "history-delete",
      { status: "DELETED", stackId: syntheticReference(original).stackId },
      at,
    );
    assert.equal(
      await work().finishTeardown(
        identity,
        "history-delete",
        { status: "DELETED", stackId: syntheticReference(original).stackId },
        at,
      ),
      "replay",
    );
  }
  assert.equal((await work().getTeardown(retry))?.historyCompleted, 1);
  assert.equal((await repository().getEvent(sourceEvent.eventId))?.teardownCompleted, 0);
  let rootIdentity = deletionIdentity(retry);
  await work().beginTeardown(rootIdentity, "current-delete", at);
  assert.equal(await work().prepareDeletion(rootIdentity, "current-delete", now + 120_001), true);
  if (mode === "recorded-old-account") {
    await work().finishTeardown(
      rootIdentity,
      "current-delete",
      { status: "FAILED", failureReason: "synthetic c091 root interruption" },
      at,
    );
    // c091 teardownSchema strips additive fields before its marker Put. Preserve that exact stored shape.
    await document.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tables.deployments,
              Key: { PK: `DEPLOYMENT#${retry.jobId}`, SK: "TEARDOWN" },
              UpdateExpression: "REMOVE historyExpected, historyCompleted",
              ConditionExpression: "generation = :generation AND #status = :failed",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":generation": 1, ":failed": "FAILED" },
            },
          },
        ],
      }),
    );
    assert.equal((await teardownRequest(sourceEvent.eventId)).status, 202);
    rootIdentity = deletionIdentity(retry, 2);
    await work().beginTeardown(rootIdentity, "current-delete", at);
    assert.equal(await work().prepareDeletion(rootIdentity, "current-delete", now + 120_001), true);
  }
  await work().finishTeardown(rootIdentity, "current-delete", { status: "DELETED" }, at);
  assert.equal((await repository().getEvent(sourceEvent.eventId))?.status, "ARCHIVED");
  assert.equal((await repository().getEvent(sourceEvent.eventId))?.teardownCompleted, 1);
  const history = (await partitionRows(`DEPLOYMENT#${original.jobId}`)).find(
    (row) => row.SK === "ATTEMPT#1",
  );
  assert.equal(history?.status, "FAILED", "Cleanup must not overwrite original attempt outcomes");
}
async function verifyHistoricalTeardownBlocker(): Promise<void> {
  for (const mode of ["recorded-old-account", "uncertain-create", "never-started"] as const)
    await verifyHistoricalTeardownCase(mode);

  console.log(
    JSON.stringify({
      milestone: "historical-attempt-teardown-boundary",
      oldAccountArn: "cleaned from immutable snapshot before current root dispatch",
      expiredUncertainCreate: "blocks",
      provenNeverStarted: "local cancellation after historical proof",
      c091CounterStripping: "failed root resumes from monotonic historical proofs",
      newJobTargetReplacement: "rejected",
    }),
  );
}

const historicalMachineArn = "arn:aws:states:us-east-1:123456789012:stateMachine:SyntheticHistory";
function historicalOwner(identity: DeploymentIdentity): string {
  return `${historicalMachineArn.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(identity)}`;
}
function historyReference(job: DeploymentJob) {
  return {
    stackId: `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/synthetic-attempt-${job.attempt}`,
    fingerprint: contentDigest(
      JSON.stringify([job.jobId, job.attempt, job.artifactDigest, job.connection]),
    ),
  };
}
async function seedHistoricalTarget(team: TeamRecord, source: EventRecord, index: number) {
  const first = makeJob(team, 0, source);
  const attempts: DeploymentJob[] = [];
  for (const attempt of [1, 2, 3]) {
    const accountId = String(700000000000 + index * 3 + attempt);
    const region = attempt === 1 ? "us-west-2" : "us-east-1";
    const catalogDigest = contentDigest(`synthetic catalog ${attempt}`);
    const job: DeploymentJob = {
      ...first,
      attempt,
      awsAccountId: accountId,
      region,
      artifactDigest: contentDigest(`synthetic historical catalog ${attempt}`),
      catalogKey: `catalogs/${catalogDigest}.json`,
      connection: {
        ...first.connection,
        accountId,
        region,
        roleArn: `arn:aws:iam::${accountId}:role/VerifiedFixtureRole`,
        version: attempt,
      },
    };
    await work().saveVerifiedConnection(job.connection, attempt === 1 ? undefined : attempt - 1);
    await work().accept({
      ...acceptance(job, team, `history-accept-${attempt}`, source),
      ...(attempt > 1 ? { retryOf: attempt - 1 } : {}),
    });
    const owner = `create-history-${job.jobId}-${attempt}`;
    await work().begin(job, owner, at);
    await work().reserveCreation(job, owner, now);
    await work().recordCreation(job, owner, historyReference(job));
    await work().finish(
      job,
      owner,
      attempt === 3
        ? {
            status: "COMPLETE",
            stackId: historyReference(job).stackId,
            flagDigest: flagDigest(`flag-${job.jobId}`),
            publicOutputs: {},
          }
        : {
            status: "FAILED",
            stackId: historyReference(job).stackId,
            failureReason: `synthetic attempt ${attempt} failure`,
          },
      at,
    );
    attempts.push(job);
  }
  const current = attempts[2];
  assert.ok(current);
  const scores = await Promise.all(
    Array.from({ length: 4 }, () =>
      work().submitFlag({
        team,
        event: source,
        jobId: current.jobId,
        attempt: 3,
        requestKey: "historical-score",
        flag: `flag-${current.jobId}`,
        now,
      }),
    ),
  );
  assert.equal(
    scores.filter((value) => value.kind === "ok" && value.scoreDelta === 100).length,
    4,
    "Communication retries replay the same scoring receipt, not additional awards",
  );
  return attempts;
}
async function preparedHistoricalDeletion(job: DeploymentJob) {
  const marker = await work().getTeardown(job);
  assert.ok(marker);
  const identity = deletionIdentity(job, marker.generation);
  const owner = historicalOwner(identity);
  await work().beginTeardown(identity, owner, at);
  assert.equal(await work().prepareDeletion(identity, owner, now + 120_001), true);
  await work().recordTeardownReference(identity, owner, historyReference(job));
  return {
    identity,
    owner,
    result: { status: "DELETED" as const, stackId: historyReference(job).stackId },
  };
}
async function finishHistoricalDeletion(job: DeploymentJob, copies = 1) {
  const { identity, owner, result } = await preparedHistoricalDeletion(job);
  const outcomes = await Promise.all(
    Array.from({ length: copies }, () => work().finishTeardown(identity, owner, result, at)),
  );
  assert.equal(outcomes.filter((value) => value === "updated").length, 1);
  assert.equal(outcomes.filter((value) => value === "replay").length, copies - 1);
}
async function reconcileConsumedHistoricalEvents(
  source: EventRecord,
  attempts: readonly DeploymentJob[][],
) {
  const pending = attempts[0]?.[0];
  const running = attempts[1]?.[0];
  assert.ok(pending && running);
  const identities = [deletionIdentity(pending), deletionIdentity(running)];
  const runningIdentity = identities[1];
  assert.ok(runningIdentity);
  await work().beginTeardown(runningIdentity, historicalOwner(runningIdentity), at);
  for (const identity of identities) {
    const root = await document.send(
      new GetCommand({
        TableName: tables.deployments,
        Key: { PK: `DEPLOYMENT#${identity.jobId}`, SK: "TEARDOWN" },
        ConsistentRead: true,
      }),
    );
    assert.notEqual(
      root.Item?.attempt,
      identity.attempt,
      "c091 getTeardown reads only the root; its recovery returns stale for this historical attempt",
    );
  }
  assert.equal((await teardownRequest(source.eventId)).status, 202);
  const operations = work();
  const selected = new Set(identities.map((identity) => identity.jobId));
  const reconciled = await dispatchPending({
    stateMachineArn: historicalMachineArn,
    repository: {
      acceptingNewDeployments: () => operations.acceptingNewDeployments(),
      listDispatch: async () =>
        (await operations.listDispatch(1000)).filter(
          (identity) =>
            identity.operation === "delete" &&
            identity.attempt === 1 &&
            selected.has(identity.jobId),
        ),
      getDeletionJob: (identity) => operations.getDeletionJob(identity),
      getTeardown: (identity) => operations.getTeardown(identity),
      finishTeardown: (identity, owner, result, time) =>
        operations.finishTeardown(identity, owner, result, time),
    },
    startExecution: async () => {
      const error = new Error("Synthetic closed execution");
      error.name = "ExecutionAlreadyExists";
      throw error;
    },
    describeExecution: async ({ executionArn }) => {
      const identity = identities.find((item) => historicalOwner(item) === executionArn);
      assert.ok(identity);
      return {
        executionArn,
        stateMachineArn: historicalMachineArn,
        status: "ABORTED",
        input: serializeDispatchIdentity(identity),
      };
    },
  });
  assert.equal(reconciled.duplicate, 2);
  for (const identity of identities)
    assert.equal((await operations.getTeardown(identity))?.status, "FAILED");
  assert.equal((await teardownRequest(source.eventId)).status, 202);
  for (const job of [pending, running])
    assert.equal((await operations.getTeardown(job))?.generation, 2);
}
async function interruptedHistoricalCompletion(job: DeploymentJob, when: "before" | "after") {
  const { identity, owner, result } = await preparedHistoricalDeletion(job);
  let armed = true;
  document.middlewareStack.add(
    (next) => async (args) => {
      const input = z
        .object({
          TransactItems: z
            .array(
              z
                .object({
                  Put: z
                    .object({
                      Item: z
                        .object({ PK: z.string().optional(), SK: z.string().optional() })
                        .passthrough(),
                    })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough()
        .parse(args.input);
      const match =
        armed &&
        input.TransactItems?.some(
          (write) =>
            write.Put?.Item.PK === `DEPLOYMENT#${job.jobId}` &&
            write.Put.Item.SK === `TEARDOWN#${job.attempt}`,
        );
      if (!match) return next(args);
      armed = false;
      if (when === "before") throw new Error("Synthetic interruption before historical commit");
      await next(args);
      throw new Error("Synthetic lost historical completion acknowledgement");
    },
    { step: "initialize", name: "syntheticHistoricalCompletionInterrupt" },
  );
  try {
    await assert.rejects(() => work().finishTeardown(identity, owner, result, at), /Synthetic/u);
    assert.equal(armed, false);
  } finally {
    document.middlewareStack.remove("syntheticHistoricalCompletionInterrupt");
  }
  const root = await work().getTeardown({ ...job, attempt: 3 });
  assert.equal(root?.historyCompleted, when === "before" ? 1 : 2);
  const rootIntents = (await work().listDispatch(1000)).filter(
    (item) => item.jobId === job.jobId && item.attempt === 3 && item.operation === "delete",
  );
  assert.equal(rootIntents.length, when === "before" ? 0 : 1);
  assert.equal(
    await work().finishTeardown(identity, owner, result, at),
    when === "before" ? "updated" : "replay",
  );
}
async function historicalEvidence(targets: readonly DeploymentJob[]) {
  return Promise.all(
    targets.map(async (job) => ({
      jobId: job.jobId,
      rows: (await partitionRows(`DEPLOYMENT#${job.jobId}`)).filter(
        (row) => typeof row.SK === "string" && /^(ATTEMPT#|CREATE#|EVENT#)/u.test(row.SK),
      ),
    })),
  );
}
async function verifyHistoricalTeardownConcurrency(): Promise<void> {
  const pagination = { pages: 0 };
  document.middlewareStack.add(
    (next) => async (args) => {
      const input = z
        .object({
          TableName: z.string().optional(),
          ExpressionAttributeValues: z.record(z.unknown()).optional(),
        })
        .passthrough()
        .parse(args.input);
      if (
        input.TableName === tables.deployments &&
        input.ExpressionAttributeValues?.[":prefix"] === "ATTEMPT#"
      ) {
        pagination.pages++;
        return next({ ...args, input: { ...args.input, Limit: 1 } });
      }
      return next(args);
    },
    { step: "initialize", name: "syntheticHistoricalPagination" },
  );
  try {
    await runHistoricalTeardownConcurrency(pagination);
  } finally {
    document.middlewareStack.remove("syntheticHistoricalPagination");
  }
}
async function runHistoricalTeardownConcurrency(pagination: { pages: number }): Promise<void> {
  const source: EventRecord = {
    ...event,
    eventId: ulid(),
    name: "Synthetic historical cleanup concurrency",
    problems: event.problems.slice(0, 1),
  };
  const members = teams.map((team, index) => ({
    ...team,
    eventId: source.eventId,
    teamId: ulid(),
    internalSlug: `history-${index}`,
    teamLoginKey: randomBytes(32).toString("base64url"),
  }));
  assert.equal(await repository().createEventWithTeams(source, members), "created");
  const attempts = await Promise.all(
    members.map((team, index) => seedHistoricalTarget(team, source, index)),
  );
  const current = attempts.map((rows) => {
    assert.ok(rows[2]);
    return rows[2];
  });
  const originalEvidence = await historicalEvidence(current);
  const receipts = await retainedReceipts(source.eventId, members);
  const projections = await repository().listTeamScores(source.eventId);
  assert.equal(
    projections.reduce((sum, item) => sum + item.score, 0),
    2500,
  );
  assert.equal((await teardownRequest(source.eventId)).status, 202);
  const firstIntents = (await work().listDispatch(1000)).filter(
    (item) => item.eventId === source.eventId && item.operation === "delete",
  );
  assert.equal(firstIntents.length, 50);
  assert.equal(
    firstIntents.some((item) => item.attempt === 3),
    false,
  );
  await reconcileConsumedHistoricalEvents(source, attempts);
  await Promise.all(
    attempts.map((rows) => {
      assert.ok(rows[0]);
      return finishHistoricalDeletion(rows[0], 4);
    }),
  );
  const before = attempts[0]?.[1];
  const after = attempts[1]?.[1];
  const failed = attempts[2]?.[1];
  assert.ok(before && after && failed);
  await interruptedHistoricalCompletion(before, "before");
  await interruptedHistoricalCompletion(after, "after");
  const partial = await preparedHistoricalDeletion(failed);
  await work().finishTeardown(
    partial.identity,
    partial.owner,
    { status: "FAILED", failureReason: "synthetic partial DELETE_FAILED" },
    at,
  );
  await Promise.all(
    attempts.slice(3).map((rows) => {
      assert.ok(rows[1]);
      return finishHistoricalDeletion(rows[1], 4);
    }),
  );
  assert.equal((await work().getTeardown({ ...failed, attempt: 3 }))?.historyCompleted, 1);
  assert.equal((await repository().getEvent(source.eventId))?.teardownCompleted, 0);
  assert.equal((await work().getJob(failed.jobId))?.score, 100);
  assert.equal((await work().getJob(failed.jobId))?.teardownStatus, "FAILED");
  assert.equal((await teardownRequest(source.eventId)).status, 202);
  assert.equal((await work().getTeardown(failed))?.generation, 2);
  await assert.rejects(
    () => work().finishTeardown(partial.identity, partial.owner, partial.result, at),
    /teardown_scope_or_generation_changed/u,
  );
  await finishHistoricalDeletion(failed, 4);
  const rootIntents = (await work().listDispatch(1000)).filter(
    (item) => item.eventId === source.eventId && item.operation === "delete",
  );
  assert.equal(rootIntents.length, 25);
  assert.equal(
    rootIntents.every((item) => item.attempt === 3),
    true,
  );
  await Promise.all(current.map((job) => finishHistoricalDeletion(job, 4)));
  const archived = await repository().getEvent(source.eventId);
  assert.equal(archived?.status, "ARCHIVED");
  assert.equal(archived.teardownExpected, 25);
  assert.equal(archived.teardownCompleted, 25);
  assert.deepEqual(await historicalEvidence(current), originalEvidence);
  assert.deepEqual(await retainedReceipts(source.eventId, members), receipts);
  assert.deepEqual(await repository().listTeamScores(source.eventId), projections);
  assert.equal((await teardownRequest(source.eventId)).status, 200);
  console.log(
    JSON.stringify({
      milestone: "historical-attempt-concurrent-cleanup",
      strongHistoricalQueryPages: pagination.pages,
      teams: 25,
      deploymentAttempts: 75,
      historicalTargets: 50,
      eventCounter: { expected: 25, completed: 25 },
      duplicateCompletions: "one terminal commit per marker",
      oldRecoveryEventsConsumed: 2,
      beforeCommitInterrupted: true,
      afterCommitAcknowledgementLost: true,
      partialFailureRetried: true,
      retainedScore: 2500,
      retainedSnapshotsCreationProofsLedgersReceipts: true,
      scope:
        "Real DynamoDB Local transactions; synthetic CFN completion observations, no AWS calls",
    }),
  );
}

const registryConfig = {
  roleName: `TenkaCloud-${"a".repeat(24)}-deploy-Role`,
  externalIdParameterArn: `arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/cloud/${"a".repeat(24)}/external-id`,
};
function registryApp(accounts: DynamoDbCompetitorAccountsRepository) {
  const repo = repository();
  const deployments = work();
  const catalog = async () => ({
    "hello-world": {
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      artifactDigest: contentDigest("synthetic-reviewed-template"),
      catalogKey: `catalogs/${contentDigest("synthetic-reviewed-catalog")}.json`,
      scoring: {
        kind: "flag" as const,
        points: 100,
        wrongPenalty: 0,
        flagOutputKey: "ExpectedFlag",
      },
      parameters: {},
    },
  });
  return createCloudApp({
    repository: repo,
    organizerAuth: AUTH,
    allowedOrigins: [],
    now: () => now,
    accounts: {
      accounts,
      tenkaCloudAccountId: "123456789012",
      competitorRoleName: registryConfig.roleName,
      defaultRegion: "us-east-1",
      assertAccepting: () => repo.assertAcceptingInstallation(),
      // SSM/STS have separate intercepted-SDK tests. This test exercises real Dynamo and existing SPA clients.
      ensureExternalId: async () => {
        await accounts.observeExternalId(registryConfig.externalIdParameterArn);
        return "SYNTHETIC-EXTERNAL-ID-ONLY";
      },
      verify: async () => undefined,
    },
    deployment: {
      work: deployments,
      catalog,
      controlPlaneAccount: "123456789012",
      prepareConnection: createRegisteredConnectionPreparer({
        accounts,
        work: deployments,
        config: registryConfig,
        catalog,
        legacyBindings: [],
      }),
    },
  });
}
async function exerciseAccountClients(
  api: CoreApiClient,
  accounts: DynamoDbCompetitorAccountsRepository,
) {
  const ids = Array.from({ length: 25 }, (_, index) => String(300000000000 + index));
  const first = ids[0];
  assert.ok(first);
  const created = await createCompetitorAccount(api, {
    awsAccountId: first,
    competitorRoleName: registryConfig.roleName,
  });
  assert.equal(created.externalId, "SYNTHETIC-EXTERNAL-ID-ONLY");
  const imported = await bulkCreateCompetitorAccounts(api, {
    defaults: { competitorRoleName: registryConfig.roleName, region: "us-east-1" },
    accounts: ids.slice(1).map((awsAccountId) => ({ awsAccountId })),
  });
  assert.equal(imported.created, 24);
  const snapshots = await Promise.all(
    ids.map(async (id) => {
      const row = await accounts.getAccount(id);
      assert.ok(row);
      return row;
    }),
  );
  assert.deepEqual(
    await Promise.all(snapshots.map((row) => accounts.createAccount(row))),
    Array.from({ length: 25 }, () => "conflict"),
  );
  for (const id of ids) assert.equal((await verifyCompetitorAccount(api, id)).verified, true);
  const original = snapshots[0];
  assert.ok(original);
  assert.equal(await accounts.setVerified(original, true, at), undefined);
  const listed = await listCompetitorAccounts(api);
  assert.equal(
    listed.items.filter((row) => ids.includes(row.awsAccountId) && row.verified).length,
    25,
  );
  assert.equal(JSON.stringify(listed).includes("externalId"), false);
  await assert.rejects(
    () =>
      createCompetitorAccount(api, {
        awsAccountId: "123456789012",
        competitorRoleName: registryConfig.roleName,
      }),
    { status: 400 },
  );
  const createdEvent = await clientCreateEvent(
    api,
    {
      name: "Existing account onboarding",
      teams: ids.map((awsAccountId, index) => ({
        internalSlug: `registry-team-${index}`,
        awsAccountId,
      })),
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    },
    "registry-event-create",
  );
  const accepted = await clientBulkDeploy(api, createdEvent.eventId, {}, "registry-bulk-deploy");
  assert.equal(accepted.enqueued, 25);
  assert.deepEqual(
    await clientBulkDeploy(api, createdEvent.eventId, {}, "registry-bulk-deploy"),
    accepted,
  );
  for (const team of createdEvent.teams) {
    const connection = await work().getConnection(createdEvent.eventId, team.teamId);
    assert.ok(connection?.registrationId);
    const record = await accounts.getAccount(connection.accountId);
    assert.equal(connection.registrationId, record?.registrationId);
  }
  await verifyRegistryAuthorizationCommit(api, accounts, first);
  await verifySharedAccountRegions(api, accounts, first);
  await assert.rejects(() => deleteCompetitorAccount(api, first), { status: 409 });
  const teardown = await clientBulkTeardown(api, createdEvent.eventId);
  assert.equal(z.object({ failed: z.number() }).parse(teardown).failed, 0);
  assert.equal((await repository().getEvent(createdEvent.eventId))?.status, "ARCHIVED");
  for (const id of ids) await deleteCompetitorAccount(api, id);
  const replacement = { ...original, registrationId: ulid() };
  assert.equal(await accounts.createAccount(replacement), "created");
  assert.equal(await accounts.setVerified(original, true, at), undefined);
  assert.equal(await accounts.deleteAccount(replacement), "deleted");
  console.log(
    JSON.stringify({
      milestone: "actual-spa-account-onboarding-client",
      accounts: 25,
      duplicateConflicts: 25,
      verifiedSelections: 25,
      automaticTeamConnections: 25,
      durableJobs: 25,
      deployReplay: "identical",
      activeAccountDeletion: "409",
      pendingJobsTeardown: "25 canceled; event archived",
      accountDeletionAfterTeardown: "25 success",
      staleVerificationAndRecreate: "rejected",
      controlPlaneAccount: "rejected",
      registryCommitFence:
        "accept and CREATE reservation roll back after concurrent revocation; reverify retries succeed",
      scope:
        "Existing SPA clients, Hono and real DynamoDB Local; ExternalId/STS injected; no AWS operations",
    }),
  );
}
async function verifySharedAccountRegions(
  api: CoreApiClient,
  accounts: DynamoDbCompetitorAccountsRepository,
  accountId: string,
) {
  const registration = await accounts.getAccount(accountId);
  assert.ok(registration?.verified);
  const regions = ["us-west-2", "ap-northeast-1"];
  const created = await clientCreateEvent(
    api,
    {
      name: "Shared account regional assignment",
      teams: regions.map((region, index) => ({
        internalSlug: `regional-${index}`,
        awsAccountId: accountId,
        region,
      })),
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    },
    "registry-regional-event",
  );
  const accepted = await clientBulkDeploy(api, created.eventId, {}, "registry-regional-deploy");
  assert.equal(accepted.enqueued, 2);
  assert.deepEqual(
    await clientBulkDeploy(api, created.eventId, {}, "registry-regional-deploy"),
    accepted,
  );
  for (const [index, team] of created.teams.entries()) {
    const connection = await work().getConnection(created.eventId, team.teamId);
    const job = await work().getTarget(created.eventId, team.teamId, "hello-world");
    assert.ok(connection && job);
    assert.equal(connection.registrationId, registration.registrationId);
    assert.equal(connection.accountId, accountId);
    assert.equal(connection.region, regions[index]);
    assert.equal(job.region, regions[index]);
    assert.equal(job.connection.teamId, team.teamId);
    assert.equal(job.connection.region, regions[index]);
  }
  assert.equal((await accounts.getAccount(accountId))?.region, registration.region);
  const teardown = await clientBulkTeardown(api, created.eventId);
  assert.equal(z.object({ failed: z.number() }).parse(teardown).failed, 0);
  assert.equal((await repository().getEvent(created.eventId))?.status, "ARCHIVED");
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-shared-account-regions",
      accounts: 1,
      teams: 2,
      regions,
      registrationRegion: registration.region,
      durableConnectionsAndJobs: 2,
      deployReplay: "identical",
      pendingTeardown: "both canceled; event archived",
      scope:
        "Existing SPA clients, Hono and real DynamoDB transactions; STS/SSM injected; no AWS execution",
    }),
  );
}
async function revokeAtAccountCheck(
  accounts: DynamoDbCompetitorAccountsRepository,
  accountId: string,
  action: () => Promise<unknown>,
) {
  let injected = false;
  document.middlewareStack.add(
    (next) => async (args) => {
      const request = z
        .object({
          TransactItems: z
            .array(
              z
                .object({
                  ConditionCheck: z
                    .object({ Key: z.record(z.unknown()) })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough()
        .safeParse(args.input);
      const touchesAccount =
        request.success &&
        request.data.TransactItems?.some(
          (item) =>
            item.ConditionCheck?.Key.PK === "INSTALLATION#ACCOUNTS" &&
            item.ConditionCheck.Key.SK === `ACCOUNT#${accountId}`,
        );
      if (!injected && touchesAccount) {
        injected = true;
        const current = await accounts.getAccount(accountId);
        assert.ok(current);
        assert.ok(await accounts.setVerified(current, false, at));
      }
      return next(args);
    },
    { step: "initialize", name: "syntheticRegistryRevocationBeforeCommit" },
  );
  try {
    await action();
    assert.equal(
      injected,
      true,
      "The actual transaction must include the current account condition",
    );
  } finally {
    document.middlewareStack.remove("syntheticRegistryRevocationBeforeCommit");
  }
}
async function verifyRegistryAuthorizationCommit(
  api: CoreApiClient,
  accounts: DynamoDbCompetitorAccountsRepository,
  accountId: string,
) {
  const created = await clientCreateEvent(
    api,
    {
      name: "Registry commit boundary",
      teams: [{ internalSlug: "guarded", awsAccountId: accountId }],
      problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    },
    "registry-fenced-event",
  );
  const team = created.teams[0];
  assert.ok(team);
  await revokeAtAccountCheck(accounts, accountId, () =>
    assert.rejects(() => clientBulkDeploy(api, created.eventId, {}, "registry-fenced-deploy"), {
      status: 409,
    }),
  );
  assert.equal(
    await work().getTarget(created.eventId, team.teamId, "hello-world"),
    undefined,
    "Rejected authorization must not publish a job or target",
  );
  assert.equal(
    (await work().listDispatch(1000)).some((intent) => intent.eventId === created.eventId),
    false,
  );
  await verifyCompetitorAccount(api, accountId);
  assert.equal(
    (await clientBulkDeploy(api, created.eventId, {}, "registry-fenced-deploy")).enqueued,
    1,
  );
  const job = await work().getTarget(created.eventId, team.teamId, "hello-world");
  assert.ok(job);
  const owner = "synthetic-registry-source";
  await work().begin(job, owner, at);
  await revokeAtAccountCheck(accounts, accountId, () =>
    assert.rejects(
      () => work().reserveCreation(job, owner, now),
      /creation_closed_or_owner_changed/u,
    ),
  );
  assert.equal(
    (await work().getCreation(job))?.state,
    "NOT_STARTED",
    "Failed reservation must retain proof that no CreateStack was sent",
  );
  await work().finish(
    job,
    owner,
    { status: "FAILED", failureReason: "synthetic_registry_revoked" },
    at,
  );
  await verifyCompetitorAccount(api, accountId);
  const requested = await clientBulkTeardown(api, created.eventId);
  assert.equal(z.object({ failed: z.number() }).parse(requested).failed, 0);
  const identity = deletionIdentity(job);
  await work().beginTeardown(identity, "synthetic-registry-delete", at);
  assert.equal(await work().prepareDeletion(identity, "synthetic-registry-delete", now), true);
  await work().finishTeardown(identity, "synthetic-registry-delete", { status: "DELETED" }, at);
  assert.equal((await repository().getEvent(created.eventId))?.status, "ARCHIVED");
}
async function verifyAccountClients() {
  const accounts = new DynamoDbCompetitorAccountsRepository(document, tables);
  assert.equal(
    await accounts.reserveExternalIdInitialization(registryConfig.externalIdParameterArn),
    true,
  );
  assert.equal(
    await accounts.reserveExternalIdInitialization(registryConfig.externalIdParameterArn),
    false,
    "An uncertain initialization must not be restarted with new key material",
  );
  const app = registryApp(accounts);
  const originalFetch = globalThis.fetch;
  const localFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, "https://registry-fixture.test");
    const gateway =
      request.headers.get("Authorization") === "Bearer synthetic-id-token"
        ? {
            event: {
              requestContext: {
                authorizer: {
                  claims: {
                    sub: "registry-organizer",
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
    return app.request(request, undefined, gateway);
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: localFetch,
  });
  try {
    await exerciseAccountClients(
      createCoreApiClient("https://registry-fixture.test", "synthetic-id-token"),
      accounts,
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
  await verifyRegistryDeletionRaces(accounts);
  assert.equal(
    await accounts.reserveExternalIdInitialization(registryConfig.externalIdParameterArn),
    false,
    "Deleting all account rows must not erase key-use history",
  );
}
async function verifyRegistryDeletionRaces(accounts: DynamoDbCompetitorAccountsRepository) {
  const raceEvent: EventRecord = {
    ...event,
    eventId: ulid(),
    name: "Registry deletion races",
    problems: event.problems.slice(0, 1),
  };
  const members = teams.map((team) => ({
    ...team,
    eventId: raceEvent.eventId,
    teamId: ulid(),
    teamLoginKey: randomBytes(32).toString("base64url"),
  }));
  assert.equal(await repository().createEventWithTeams(raceEvent, members), "created");
  const records: CompetitorAccountRecord[] = members.map((_, index) => ({
    awsAccountId: String(400000000000 + index),
    region: "us-east-1",
    competitorRoleName: registryConfig.roleName,
    createdAt: at,
    updatedAt: at,
    createdBy: "synthetic-admin",
    registrationId: ulid(),
    revision: 1,
    verified: false,
  }));
  const winners = { linked: 0, deleted: 0, conflict: 0 };
  for (const [index, record] of records.entries()) {
    assert.equal(await accounts.createAccount(record), "created");
    const verified = await accounts.setVerified(record, true, at);
    const team = members[index];
    assert.ok(verified && team);
    const connection = {
      eventId: raceEvent.eventId,
      teamId: team.teamId,
      accountId: record.awsAccountId,
      region: record.region,
      roleArn: `arn:aws:iam::${record.awsAccountId}:role/${registryConfig.roleName}`,
      externalIdParameter: registryConfig.externalIdParameterArn,
      bindingId: `account-${record.registrationId.toLowerCase()}`,
      registrationId: record.registrationId,
      version: 1,
      verifiedAt: at,
      reviewedProblemIds: ["hello-world"],
    };
    const [saved, removed] = await Promise.all([
      accounts.saveConnection({ record: verified, event: raceEvent, team, connection, now }),
      accounts.deleteAccount(verified),
    ]);
    assert.equal(
      saved === "saved" && removed === "deleted",
      false,
      "A linked account must not be deleted concurrently",
    );
    if (saved === "saved") {
      winners.linked++;
      const current = await accounts.getAccount(record.awsAccountId);
      assert.ok(current);
      assert.equal(await accounts.deleteAccount(current), "in_use");
    } else if (removed === "deleted") {
      winners.deleted++;
      assert.equal(await work().getConnection(raceEvent.eventId, team.teamId), undefined);
    } else winners.conflict++;
  }
  const closed = await teardownRequest(raceEvent.eventId);
  assert.equal(closed.status, 202, await closed.clone().text());
  assert.equal((await repository().getEvent(raceEvent.eventId))?.status, "ARCHIVED");
  for (const record of records) {
    const current = await accounts.getAccount(record.awsAccountId);
    if (current) assert.equal(await accounts.deleteAccount(current), "deleted");
  }
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-registry-reference-races",
      races: 25,
      winners,
      orphanedConnections: 0,
      activeReferenceDeletion: "rejected",
      cleanupAfterArchive: "passed",
      scope: "Real Dynamo transactions; no SSM, STS or CloudFormation",
    }),
  );
}

async function verifyParticipantCliAuthorization() {
  const source: EventRecord = {
    ...event,
    eventId: ulid(),
    teamCount: 2,
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
  };
  const members = teams.slice(0, 2).map((team) => ({
    ...team,
    eventId: source.eventId,
    teamId: ulid(),
    teamLoginKey: randomBytes(32).toString("base64url"),
  }));
  const team = members[0],
    other = members[1];
  assert.ok(team && other);
  const repo = repository(),
    operations = work();
  assert.equal(await repo.createEventWithTeams(source, members), "created");
  const base = makeJob(team, 0, source);
  const stackName = deploymentStackName(source.eventId, team.teamId, "hello-world");
  const job: DeploymentJob = {
    ...base,
    problemId: "hello-world",
    problemDir: "problems/challenges/hello-world",
    stackName,
    parameters: {
      NamePrefix: stackName,
      TenkaCloudAccountId: "210987654321",
      ExternalId: base.jobId,
    },
  };
  const artifact = {
    artifactDigest: job.artifactDigest,
    templateBody: "synthetic-template",
    capabilities: [],
    publicOutputKeys: ["ParameterName"],
  };
  const { input } = buildDeploymentInput(job, artifact);
  const fingerprint = deploymentIdentity(input).fingerprint;
  const stackId = `arn:aws:cloudformation:${job.region}:${job.awsAccountId}:stack/${job.stackName}/synthetic-cli-stack`;
  const owner = "synthetic-cli-owner";
  await operations.saveVerifiedConnection(job.connection);
  await operations.accept(acceptance(job, team, "participant-cli", source));
  await operations.begin(job, owner, at);
  await operations.reserveCreation(job, owner, now);
  await operations.recordCreation(job, owner, { stackId, fingerprint });
  await operations.finish(job, owner, { ...completion(job), stackId }, at);
  const credentials = {
    AccessKeyId: "ASIADUMMY00000000000",
    SecretAccessKey: "SyntheticOnlySecret0000000000000000000000",
    SessionToken: "SyntheticOnlySession000000000000000000000",
    Expiration: new Date(now + 900_000),
  };
  const roleName = "SyntheticViewerRole";
  let issued = 0,
    revokeDuringIssue = false,
    armFinalReadRace = false,
    revokeDuringFinalRead = false;
  const access: CloudParticipantAccess = {
    work: {
      getJob: operations.getJob.bind(operations),
      getTarget: operations.getTarget.bind(operations),
      getCreation: operations.getCreation.bind(operations),
      acceptingNewDeployments: operations.acceptingNewDeployments.bind(operations),
      assertParticipantAccessCurrent: operations.assertParticipantAccessCurrent.bind(operations),
      getConnection: async (eventId, teamId) => {
        const result = await operations.getConnection(eventId, teamId);
        if (revokeDuringFinalRead) {
          revokeDuringFinalRead = false;
          const current = await repo.getTeam(source.eventId, team.teamId);
          assert.ok(current);
          assert.equal(await repo.rotateTeamAccess(current, undefined, at), "updated");
        }
        return result;
      },
    },
    controlPlaneAccount: "210987654321",
    resolveArtifacts: async () => artifact,
    authorizeJob: async (current) => {
      assert.equal(current.connection.roleArn, job.connection.roleArn);
    },
    runner: {
      now: () => now,
      ssm: () => ({
        getParameter: async () => ({
          Parameter: {
            ARN: job.connection.externalIdParameter,
            Type: "SecureString",
            Value: "synthetic-external-id",
          },
        }),
      }),
      sts: { assumeRole: async () => ({ Credentials: credentials }) },
      cloudFormation: () => ({
        describeStacks: async () => ({
          Stacks: [
            {
              StackId: stackId,
              StackName: stackName,
              StackStatus: "CREATE_COMPLETE",
              Tags: deploymentOwnershipTags(input),
              Outputs: [
                {
                  OutputKey: "ParticipantViewerRoleArn",
                  OutputValue: `arn:aws:iam::${job.awsAccountId}:role/${roleName}`,
                },
                { OutputKey: "ParameterName", OutputValue: `/${stackName}/hello` },
              ],
            },
          ],
        }),
        describeStackResource: async () => ({
          StackResourceDetail: {
            StackId: stackId,
            LogicalResourceId: "ParticipantViewerRole",
            ResourceType: "AWS::IAM::Role",
            ResourceStatus: "CREATE_COMPLETE",
            PhysicalResourceId: roleName,
          },
        }),
        createStack: async () => {
          throw new Error("CLI must never create resources");
        },
        deleteStack: async () => {
          throw new Error("CLI must never delete resources");
        },
      }),
    },
    sts: {
      send: async (command) => {
        assert.equal(command.input.ExternalId, job.jobId);
        assert.equal(command.input.DurationSeconds, 900);
        assert.ok(command.input.Policy?.includes(`parameter/${stackName}/hello`));
        if (revokeDuringIssue) {
          revokeDuringIssue = false;
          const current = await repo.getTeam(source.eventId, team.teamId);
          assert.ok(current);
          assert.equal(await repo.rotateTeamAccess(current, undefined, at), "updated");
        }
        if (armFinalReadRace) revokeDuringFinalRead = true;
        issued++;
        return {
          $metadata: {},
          Credentials: credentials,
          AssumedRoleUser: {
            AssumedRoleId: "SYNTHETIC",
            Arn: `arn:aws:sts::${job.awsAccountId}:assumed-role/${roleName}/tc-view-${job.jobId}`,
          },
        };
      },
    },
  };
  const app = createCloudApp({
    repository: repo,
    organizerAuth: AUTH,
    allowedOrigins: [],
    now: () => now,
    participantAccess: access,
  });
  const request = (member: TeamRecord, route = "cli-credentials") =>
    app.request(`/portal/me/${route}?jobId=${job.jobId}`, {
      headers: { Authorization: `Bearer ${member.teamLoginKey}` },
    });
  const ready = await request(team);
  assert.equal(ready.status, 200, await ready.clone().text());
  assert.equal(ready.headers.get("Cache-Control"), "no-store");
  assert.equal(
    z.object({ credentials: z.object({ awsAccountId: z.string() }) }).parse(await ready.json())
      .credentials.awsAccountId,
    job.awsAccountId,
  );
  assert.equal((await request(other)).status, 403);
  const consoleResponse = await request(team, "console-signin-url");
  assert.equal(consoleResponse.status, 409);
  assert.equal(issued, 1);
  armFinalReadRace = true;
  const finalRace = await request(team);
  assert.equal(
    revokeDuringFinalRead,
    false,
    "the real revocation transaction ran inside the final connection read",
  );
  assert.equal(finalRace.status, 409, await finalRace.clone().text());
  assert.equal((await finalRace.text()).includes(credentials.SecretAccessKey), false);
  armFinalReadRace = false;
  const expiredTeam = await repo.getTeam(source.eventId, team.teamId);
  assert.ok(expiredTeam);
  assert.equal(
    await repo.rotateTeamAccess(expiredTeam, randomBytes(32).toString("base64url"), at),
    "updated",
  );
  const currentTeam = await repo.getTeam(source.eventId, team.teamId);
  assert.ok(currentTeam);
  revokeDuringIssue = true;
  const revoked = await request(currentTeam);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.text()).includes(credentials.SecretAccessKey), false);
  assert.equal((await request(currentTeam)).status, 401);
  assert.equal(issued, 3, "revocation suppresses both raced responses and all subsequent issuance");
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-participant-cli-authorization",
      ready: "existing CLI contract with no-store",
      crossTeam: "403 before issuance",
      console: "409 with no issuance",
      revokedDuringSts: "Dynamo transaction observed; credentials withheld",
      revokedDuringFinalConnectionRead:
        "atomic ConditionCheck release rejects stale authenticated snapshot; credentials withheld",
      subsequentRevokedRequests: "401 before issuance",
      sessionLimitSeconds: 900,
      scope:
        "Real DynamoDB authentication/ownership and Hono HTTP; STS/SSM/CloudFormation are injected, no AWS operations",
    }),
  );
}

async function seedGlobalPagination(names: typeof tables, source: EventRecord, team: TeamRecord) {
  for (let offset = 0; offset < 205; offset += 100) {
    await document.send(
      new TransactWriteCommand({
        TransactItems: Array.from({ length: Math.min(100, 205 - offset) }, (_, index) => ({
          Put: {
            TableName: names.events,
            Item: { PK: `SYNTHETIC-NON-EVENT#${offset + index}`, SK: "DATA" },
          },
        })),
      }),
    );
  }
  await document.send(
    new TransactWriteCommand({
      TransactItems: Array.from({ length: 20 }, (_, index) => ({
        Put: {
          TableName: names.deployments,
          Item: {
            PK: "DISPATCH#PENDING",
            SK: `${String(index).padStart(26, "0")}#1`,
            eventId: source.eventId,
            teamId: team.teamId,
            jobId: String(index).padStart(26, "0"),
            attempt: 1,
            createdAt: at,
          },
        },
      })),
    }),
  );
}
async function verifyInstallationStopAndDrain() {
  const names = {
    events: `${prefix}-global-events`,
    teams: `${prefix}-global-teams`,
    deployments: `${prefix}-global-deployments`,
  };
  await createTables(names);
  const repo = new DynamoCloudRepository(document, names);
  const operations = new DynamoDeploymentWork(document, names);
  const scope = {
    account: "210987654321",
    region: "us-east-1",
    environment: "verification",
    applicationStackId:
      "arn:aws:cloudformation:us-east-1:210987654321:stack/tenkacloud-cloud-verification/synthetic-app",
    backendStackId:
      "arn:aws:cloudformation:us-east-1:210987654321:stack/tenkacloud-cloud-problem-deploy-verification/synthetic-backend",
  };
  const source: EventRecord = {
    ...event,
    eventId: ulid(),
    teamCount: 3,
    problems: event.problems.slice(0, 3),
  };
  const members = teams.slice(0, 3).map((team) => ({
    ...team,
    eventId: source.eventId,
    teamId: ulid(),
    teamLoginKey: randomBytes(32).toString("base64url"),
  }));
  assert.equal(await repo.createEventWithTeams(source, members), "created");
  const idle: EventRecord = { ...source, eventId: ulid(), teamCount: 1 };
  const base = members[0];
  assert.ok(base);
  const idleTeam = {
    ...base,
    eventId: idle.eventId,
    teamId: ulid(),
    teamLoginKey: randomBytes(32).toString("base64url"),
  };
  assert.equal(await repo.createEventWithTeams(idle, [idleTeam]), "created");
  const targets = members.map((team) => makeJob(team, 0, source));
  for (const [index, job] of targets.entries()) {
    const team = members[index];
    assert.ok(team);
    await operations.saveVerifiedConnection(job.connection);
    await operations.accept(acceptance(job, team, `global-${index}`, source));
  }
  const pending = targets[0],
    running = targets[1],
    complete = targets[2],
    scorer = members[2];
  assert.ok(pending && running && complete && scorer);
  for (const job of [running, complete]) {
    await operations.begin(job, `owner-${job.jobId}`, at);
    await operations.reserveCreation(job, `owner-${job.jobId}`, now);
  }
  await operations.recordCreation(
    complete,
    `owner-${complete.jobId}`,
    syntheticReference(complete),
  );
  await operations.finish(complete, `owner-${complete.jobId}`, completion(complete), at);
  const flag = {
    event: source,
    team: scorer,
    jobId: complete.jobId,
    attempt: 1,
    requestKey: "global-before-stop",
    flag: `flag-${complete.jobId}`,
    now,
  };
  assert.equal((await operations.submitFlag(flag)).kind, "ok");
  await seedGlobalPagination(names, source, base);
  let eventScanPages = 0,
    emptyEventPages = 0,
    emptyDeletePages = 0;
  document.middlewareStack.add(
    (next, context) => async (args) => {
      const response = await next(args);
      const input = z
        .object({
          TableName: z.string().optional(),
          ConsistentRead: z.boolean().optional(),
          FilterExpression: z.string().optional(),
        })
        .passthrough()
        .parse(args.input);
      const output = z
        .object({ Items: z.array(z.unknown()).optional() })
        .passthrough()
        .parse(response.output);
      if (context.commandName === "ScanCommand" && input.TableName === names.events) {
        assert.equal(input.ConsistentRead, true);
        eventScanPages++;
        if (output.Items?.length === 0) emptyEventPages++;
      }
      if (
        context.commandName === "QueryCommand" &&
        input.TableName === names.deployments &&
        input.FilterExpression === "#operation = :delete" &&
        output.Items?.length === 0
      )
        emptyDeletePages++;
      return response;
    },
    { step: "initialize", name: "syntheticGlobalDrainPagination" },
  );
  try {
    await assert.rejects(
      () => repo.listStoppedInstallationEvents(scope),
      /installation_not_stopped/u,
    );
    const stopped = await repo.stopAcceptingInstallation(scope, at);
    assert.equal(stopped.status, "DRAINING");
    assert.deepEqual(await repo.stopAcceptingInstallation(scope, at), stopped);
    assert.equal(await operations.acceptingNewDeployments(), false);
    await assert.rejects(
      () =>
        repo.stopAcceptingInstallation(
          {
            ...scope,
            applicationStackId: scope.applicationStackId.replace("synthetic-app", "different-app"),
          },
          at,
        ),
      /installation_scope_changed/u,
    );
    const rejected = { ...idle, eventId: ulid() };
    await assert.rejects(
      () => repo.createEventWithTeams(rejected, [{ ...idleTeam, eventId: rejected.eventId }]),
      /installation_draining/u,
    );
    await assert.rejects(
      () =>
        operations.accept(acceptance(makeJob(base, 1, source), base, "global-after-stop", source)),
      /deployment_acceptance_conflict/u,
    );
    await assert.rejects(() => operations.begin(pending, "post-stop-owner", at));
    await assert.rejects(
      () => operations.reserveCreation(running, `owner-${running.jobId}`, now),
      /creation_closed_or_owner_changed/u,
    );
    await assert.rejects(
      () => operations.submitFlag({ ...flag, requestKey: "global-after-stop" }),
      /scope_or_access_changed/u,
    );
    await assert.rejects(() => operations.submitFlag(flag), /scope_or_access_changed/u);
    const listed = await repo.listStoppedInstallationEvents(scope);
    assert.deepEqual(
      listed.map((item) => item.eventId).sort(),
      [source.eventId, idle.eventId].sort(),
    );
    assert.ok(eventScanPages >= 3 && emptyEventPages > 0);
    await assert.rejects(() => repo.confirmInstallationDrained(scope, at), /events_not_drained/u);
    // A previously reserved request may still report its immutable result after intake stops.
    await operations.recordCreation(running, `owner-${running.jobId}`, syntheticReference(running));
    await operations.finish(
      running,
      `owner-${running.jobId}`,
      {
        status: "FAILED",
        stackId: completion(running).stackId,
        failureReason: "synthetic-late-create-result",
      },
      at,
    );
    for (const current of [source, idle]) {
      await operations.closeEvent(current, at);
      const scopedTeams = await repo.listTeamsByEvent(current.eventId);
      const jobs = (
        await Promise.all(
          scopedTeams.map((team) => operations.listTargetJobs(current.eventId, team.teamId)),
        )
      ).flat();
      await operations.setTeardownExpected(current.eventId, jobs.length);
      for (const job of jobs) await operations.requestTeardown(job, at);
      await operations.archiveTeardown(current.eventId);
    }
    const firstDelete = await operations.listDispatch(1, { deletesOnly: true });
    assert.equal(firstDelete.length, 1);
    assert.equal(firstDelete[0]?.operation, "delete");
    assert.ok(emptyDeletePages >= 20, "DELETE discovery must cross empty filtered CREATE pages");
    const deletions = await operations.listDispatch(10, { deletesOnly: true });
    assert.equal(deletions.length, 2);
    for (const identity of deletions) {
      const job = await operations.getJob(identity.jobId);
      assert.ok(job);
      const owner = `delete-${job.jobId}`;
      await operations.beginTeardown(identity, owner, at);
      assert.equal(await operations.prepareDeletion(identity, owner, now + 120001), true);
      await operations.finishTeardown(
        identity,
        owner,
        { status: "DELETED", stackId: completion(job).stackId },
        at,
      );
    }
    assert.equal((await repo.getEvent(source.eventId))?.status, "ARCHIVED");
    assert.equal((await operations.getJob(complete.jobId))?.score, 100);
    await repo.confirmInstallationDrained(scope, at);
    await repo.confirmInstallationDrained(scope, at);
    assert.equal((await repo.installationControl())?.status, "DRAINED");
    assert.equal((await operations.listDispatch(10, { deletesOnly: true })).length, 0);
    assert.equal(await operations.acceptingNewDeployments(), false);
    console.log(
      JSON.stringify({
        milestone: "real-dynamodb-installation-stop-and-drain",
        events: 2,
        targets: 3,
        blocked: [
          "creation",
          "deployment acceptance",
          "CREATE claim/reservation",
          "new scoring",
          "receipt replay",
          "foreign physical stack scope",
        ],
        lateCreationResult: "preserved after intake stop",
        eventScanPages,
        emptyEventPages,
        emptyDeletePages,
        completeState: "DRAINED; repeated confirmation succeeds",
        scoresRetained: 100,
        staleCreateIntents: "cannot execute or starve DELETE discovery",
        scope: "Real Dynamo transactions and pagination; no AWS/CloudFormation calls",
      }),
    );
  } finally {
    document.middlewareStack.remove("syntheticGlobalDrainPagination");
  }
}

interface NativeFixture {
  readonly clock: () => number;
  readonly timings: Record<string, number>;
  readonly io: {
    readBinaryBytes: number;
    attemptedWriteBinaryBytes: number;
    failedCommands: number;
    commands: number;
  };
  readonly repo: DynamoCloudRepository;
  readonly operations: DynamoDeploymentWork;
  readonly names: typeof tables;
  readonly source: EventRecord;
  readonly roster: TeamRecord[];
  readonly artifact: NativeCoordinationArtifact;
  readonly descriptor: NativeProblem;
  readonly measurements: CoordinationWriteMeasurement[];
  readonly store: () => DynamoDeploymentsCoordination;
  readonly app: () => ReturnType<typeof createCloudApp>;
}
interface SyntheticNativeState {
  padding: string;
  scores: Record<string, number>;
  operations: number;
}
function syntheticNativePlugin(padding: number): HostPlugin {
  return {
    initialState: (context) => ({
      padding: "x".repeat(padding),
      operations: 0,
      scores: Object.fromEntries(context.teamIds.map((id) => [id, 0])),
    }),
    validateOp: (_state, _id, op) =>
      (op as { kind: string }).kind === "reject"
        ? { ok: false, error: "synthetic_rejected" }
        : { ok: true },
    applyOp: (raw, id, op) => {
      const state = raw as SyntheticNativeState;
      const kind = (op as { kind: string }).kind;
      const delta = kind === "penalty" ? -2 : 1;
      return {
        ...state,
        operations: state.operations + 1,
        scores: Object.fromEntries(
          Object.entries(state.scores).map(([teamId, score]) => [
            teamId,
            score + (kind === "all" || teamId === id ? delta : 0),
          ]),
        ),
      };
    },
    projectForTeam: (raw, id) => ({ teamId: id, score: (raw as SyntheticNativeState).scores[id] }),
    teamScores: (raw) => (raw as SyntheticNativeState).scores,
    tickOnRequest: true,
    tick: (state) => state,
  };
}
async function nativeFixture(
  names: typeof tables,
  count: number,
  plugin: HostPlugin,
  descriptor?: NativeProblem,
  clock: () => number = () => Date.now(),
): Promise<NativeFixture> {
  const repo = new DynamoCloudRepository(document, names);
  const operations = new DynamoDeploymentWork(document, names);
  const source: EventRecord = {
    ...event,
    eventId: ulid(),
    name: "Synthetic native transaction acceptance",
    teamCount: count,
    status: "DRAFT",
    problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "us-east-1" }],
  };
  const roster = Array.from(
    { length: count },
    (_, index): TeamRecord => ({
      eventId: source.eventId,
      teamId: ulid(),
      internalSlug: `native-${index}`,
      teamLoginKey: randomBytes(32).toString("base64url"),
      authVersion: 1,
      accessRevoked: false,
      createdAt: at,
      updatedAt: at,
      expiresAt: source.expiresAt,
    }),
  );
  assert.equal(await repo.createEventWithTeams(source, roster), "created");
  const artifactDigest = contentDigest("synthetic-native-capacity-plugin");
  descriptor ??= {
    kind: "coordination",
    problemId: "ac26-crypto-battle",
    problemDir: "problems/battles/ac26-crypto-battle",
    artifactDigest,
    pluginKey: `plugins/${artifactDigest}.mjs`,
    catalogKey: `catalogs/${contentDigest("synthetic-native-catalog")}.json`,
    stateBudget: { bytesPerTeam: 31744, baseBytes: 1536 },
    name: "Synthetic native Battle",
    description: "Offline acceptance",
    instructions: "Play",
  };
  const artifact = { ...descriptor, plugin };
  const measurements: CoordinationWriteMeasurement[] = [];
  const timings: Record<string, number> = {};
  const io = { readBinaryBytes: 0, attemptedWriteBinaryBytes: 0, failedCommands: 0, commands: 0 };
  const store = () =>
    new DynamoDeploymentsCoordination(
      document,
      names,
      (sample) => measurements.push(sample),
      (sample) => {
        timings[sample.phase] = (timings[sample.phase] ?? 0) + sample.elapsedMs;
      },
    );
  document.middlewareStack.add(
    (next) => async (args) => {
      // Only this native run's keys; totals include retry attempts and exclude other fixtures.
      const serializedKeys = JSON.stringify(args.input, (key, value: unknown) =>
        key === "data" ? undefined : value,
      );
      if (!serializedKeys.includes(source.eventId)) return next(args);
      io.commands++;
      io.attemptedWriteBinaryBytes += binaryBytes(args.input);
      const start = performance.now();
      try {
        const result = await next(args);
        io.readBinaryBytes += binaryBytes(result.output);
        return result;
      } catch (error) {
        io.failedCommands++;
        throw error;
      } finally {
        timings.sdkAwait = (timings.sdkAwait ?? 0) + performance.now() - start;
      }
    },
    { step: "initialize", name: `nativeMetrics${source.eventId}` },
  );
  const app = () =>
    createCloudApp({
      repository: repo,
      now: clock,
      organizerAuth: AUTH,
      allowedOrigins: [],
      deployment: {
        work: operations,
        catalog: async () => ({}),
        controlPlaneAccount: "123456789012",
      },
      coordination: {
        store: store(),
        catalog: async () => ({ [artifact.problemId]: artifact }),
        resolve: async () => ({ descriptor: artifact, plugin }),
      },
    });
  return {
    clock,
    timings,
    io,
    repo,
    operations,
    names,
    source,
    roster,
    artifact,
    descriptor,
    measurements,
    store,
    app,
  };
}
function binaryBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + binaryBytes(item), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce<number>((sum, item) => sum + binaryBytes(item), 0);
  return 0;
}
function nativeMeasurement(fixture: NativeFixture) {
  return {
    phaseTotalMs: Object.fromEntries(
      Object.entries(fixture.timings).map(([key, value]) => [key, Math.round(value)]),
    ),
    readBinaryBytes: fixture.io.readBinaryBytes,
    attemptedWriteBinaryBytes: fixture.io.attemptedWriteBinaryBytes,
    failedCommandsCumulative: fixture.io.failedCommands,
    sdkCommandsCumulative: fixture.io.commands,
    timingScope:
      "Cumulative per-phase wall time across concurrent requests; SDK awaits include serialization and overlap, not additive latency",
  };
}

async function nativeOrganizer(
  fixture: NativeFixture,
  suffix: string,
  method = "POST",
  data: unknown = {},
) {
  return fixture.app().request(
    `/events/${fixture.source.eventId}${suffix}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `native-${suffix.replace(/\W/gu, "_")}`,
      },
      body: JSON.stringify(data),
    },
    {
      event: {
        requestContext: {
          authorizer: {
            claims: {
              sub: "synthetic-native-organizer",
              iss: AUTH.issuer,
              aud: AUTH.audience,
              exp: now / 1000 + 3600,
              token_use: "id",
              "custom:userRole": "Admin",
            },
          },
        },
      },
    },
  );
}
async function nativeCurrent(fixture: NativeFixture) {
  const source = await fixture.repo.getEvent(fixture.source.eventId);
  assert.ok(source);
  return source;
}
async function nativeRows(fixture: NativeFixture) {
  const rows: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(
      new QueryCommand({
        TableName: fixture.names.deployments,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": coordinationHeadKey(fixture.source.eventId, fixture.artifact.problemId).PK,
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    rows.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
async function nativeMove(
  fixture: NativeFixture,
  team: TeamRecord,
  op: unknown,
  key: string,
  clock = fixture.clock,
) {
  return fixture.store().request({
    event: await nativeCurrent(fixture),
    team,
    artifact: fixture.artifact,
    now: clock,
    operation: { key, hash: contentDigest(JSON.stringify({ op })), op },
  });
}
async function initializeNative(fixture: NativeFixture) {
  const response = await nativeOrganizer(fixture, "/deploy");
  assert.equal(response.status, 202, await response.clone().text());
  const body = (await response.json()) as { initialized: number; enqueued: number };
  assert.equal(body.initialized, 1);
  assert.equal(body.enqueued, 0);
  assert.equal((await nativeCurrent(fixture)).status, "READY");
  const run = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(run);
  assert.equal(run.roster.length, fixture.roster.length);
  return run;
}
async function nativeClientLoad(fixture: NativeFixture) {
  const originalFetch = globalThis.fetch;
  let conflicts = 0;
  const latencies: number[] = [];
  const responses: unknown[] = [];
  const attempts = Array.from({ length: 100 }, () => 0);
  const errorCodes: Record<string, number> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await fixture.app().request(new URL(request.url).pathname, request);
    if (response.status !== 200) {
      const body = z.object({ error: z.string() }).parse(await response.clone().json());
      errorCodes[body.error] = (errorCodes[body.error] ?? 0) + 1;
    }
    return response;
  }) as typeof fetch;
  const begin = performance.now();
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, async (_, index) => {
        const team = fixture.roster[index % 25];
        assert.ok(team);
        const start = performance.now();
        for (let attempt = 0; attempt < 12; attempt++) {
          attempts[index] = attempt + 1;
          const result = await clientCoordinationOp(
            "https://native.invalid",
            team.teamLoginKey,
            { kind: "point" },
            undefined,
            `native-client-${index}`,
          );
          if (result.kind === "conflict") {
            conflicts++;
            await new Promise((resolve) => setTimeout(resolve, 30 + (index % 29)));
            continue;
          }
          assert.equal(result.kind, "ok", JSON.stringify(result));
          responses[index] = result;
          latencies.push(performance.now() - start);
          return;
        }
        assert.fail("Native client exhausted bounded conflict retry");
      }),
    );
    const elapsedMs = Math.round(performance.now() - begin);
    const before = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
    assert.ok(before);
    const committed = (before.match.state as SyntheticNativeState).operations;
    const receipts = new Set(
      (await nativeRows(fixture)).filter((row) => row.requestHash).map((row) => row.SK),
    );
    const receiptIndices = Array.from({ length: 100 }, (_, index) => index).filter((index) => {
      const team = fixture.roster[index % 25];
      assert.ok(team);
      const operationDigest = contentDigest(`native-client-${index}`);
      return receipts.has(`RECEIPT#${before.runId}#${team.teamId}#${operationDigest}`);
    });
    assert.equal(receiptIndices.length, committed);
    assert.equal(
      Object.values(before.match.scores).reduce((a, b) => a + b, 0),
      committed,
    );
    for (const index of receiptIndices) {
      const team = fixture.roster[index % 25];
      assert.ok(team);
      const replay = await clientCoordinationOp(
        "https://native.invalid",
        team.teamLoginKey,
        { kind: "point" },
        undefined,
        `native-client-${index}`,
      );
      assert.equal(replay.kind, "ok");
      if (responses[index] !== undefined) assert.deepEqual(replay, responses[index]);
    }
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    const unexpected = failed.filter(
      (outcome) =>
        !(outcome.reason instanceof Error) ||
        !outcome.reason.message.includes("exhausted bounded conflict retry"),
    );
    const finalHead = await document.send(
      new GetCommand({
        TableName: fixture.names.deployments,
        Key: coordinationHeadKey(fixture.source.eventId, fixture.artifact.problemId),
        ConsistentRead: true,
      }),
    );
    const capacityMet = failed.length === 0 && committed === 100;
    nativeCapacityMet &&= capacityMet;
    assert.equal(
      (await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId))?.revision,
      before.revision,
    );
    assert.equal(
      (await fixture.repo.listTeamScores(fixture.source.eventId)).reduce(
        (sum, row) => sum + row.score,
        0,
      ),
      committed,
    );
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        milestone: "real-dynamodb-native-100-client-operations",
        teams: 25,
        participants: 100,
        successfulOperations: committed,
        exactReceiptReplays: receiptIndices.length,
        totalScore: committed,
        allOperationIntentsEventuallyAcknowledged: capacityMet,
        finalSnapshotBytes: Buffer.byteLength(JSON.stringify(before.match)),
        outcomeCounts: {
          acknowledged: latencies.length,
          retryExhaustions: failed.length - unexpected.length,
          unexpectedErrors: unexpected.length,
        },
        errorCodes,
        admissionHeld: typeof finalHead.Item?.admissionOwner === "string",
        remainingLeaseMs:
          typeof finalHead.Item?.admissionExpiresAt === "number"
            ? finalHead.Item.admissionExpiresAt - fixture.clock()
            : 0,
        retryAttemptHistogram: Object.fromEntries(
          [...new Set(attempts)]
            .sort((a, b) => a - b)
            .map((count) => [String(count), attempts.filter((value) => value === count).length]),
        ),
        conflictsRetriedByActualClient: conflicts,
        elapsedMs,
        p95Ms: Math.round(latencies[94] ?? 0),
        scope:
          "Real Dynamo transactions through existing SPA client and Hono; synthetic large state plugin",
        ...nativeMeasurement(fixture),
      }),
    );
    for (const outcome of unexpected) throw outcome.reason;
    return before;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
async function nativePolling(fixture: NativeFixture, canonical = false) {
  const refreshLatencies: number[] = [];
  const counts = {
    commands: 0,
    readRows: 0,
    writes: 0,
    deploymentEventQueries: 0,
    projectionConflicts: 0,
    successfulProjections: 0,
  };
  document.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      counts.commands++;
      const out = z
        .object({
          Items: z.array(z.unknown()).optional(),
          Responses: z.array(z.unknown()).optional(),
          Item: z.unknown().optional(),
        })
        .passthrough()
        .parse(result.output);
      counts.readRows += out.Items?.length ?? out.Responses?.length ?? (out.Item ? 1 : 0);
      const input = z
        .object({
          TransactItems: z.array(z.record(z.unknown())).optional(),
          IndexName: z.string().optional(),
          KeyConditionExpression: z.string().optional(),
          TableName: z.string().optional(),
        })
        .passthrough()
        .parse(args.input);
      if (["TransactWriteCommand", "TransactWriteItemsCommand"].includes(context.commandName ?? ""))
        counts.writes += (input.TransactItems ?? []).filter(
          (item) => item.Put || item.Update || item.Delete,
        ).length;
      if (
        input.TableName === fixture.names.deployments &&
        input.IndexName === "GSI1" &&
        !input.KeyConditionExpression?.includes("begins_with")
      )
        counts.deploymentEventQueries++;
      return result;
    },
    { step: "initialize", name: "nativePollingMeasurement" },
  );
  const started = performance.now();
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, async (_, index) => {
        const refreshStarted = performance.now();
        const team = fixture.roster[index % 25];
        assert.ok(team);
        for (const route of [
          "/portal/me",
          "/portal/me/coordination/projection",
          "/portal/leaderboard",
        ]) {
          const response = await fixture
            .app()
            .request(route, { headers: { authorization: `Bearer ${team.teamLoginKey}` } });
          if (canonical && route.endsWith("/projection") && response.status === 409) {
            counts.projectionConflicts++;
            continue;
          }
          assert.equal(response.status, 200, await response.clone().text());
          if (route.endsWith("/projection")) counts.successfulProjections++;
          if (route === "/portal/me") {
            const body = (await response.json()) as {
              problems: { runtimeKind?: string; jobId: string; awsAccountId?: string }[];
            };
            assert.equal(body.problems[0]?.runtimeKind, "coordination");
            assert.equal(body.problems[0]?.awsAccountId, undefined);
          }
        }
        refreshLatencies.push(performance.now() - refreshStarted);
      }),
    );
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    if (canonical) assert.ok(counts.successfulProjections > 0);
    if (!canonical)
      assert.equal(counts.writes, 0, "Semantic no-op polling must not republish large snapshots");
    assert.equal(counts.deploymentEventQueries, 0);
    const elapsedMs = Math.round(performance.now() - started);
    refreshLatencies.sort((a, b) => a - b);
    const refreshWithinPollInterval = elapsedMs < 5000 && counts.successfulProjections === 100;
    if (canonical) nativeCapacityMet &&= refreshWithinPollInterval;
    console.log(
      JSON.stringify({
        milestone: canonical
          ? "real-dynamodb-canonical-http-polling"
          : "real-dynamodb-native-http-polling",
        participants: 100,
        teams: 25,
        requests: 300,
        configuredShellPollIntervalMs: POLL_INTERVAL_MS,
        configuredCryptoPollIntervalMs: 5000,
        elapsedMs,
        refreshWithinPollInterval,
        refreshP50Ms: Math.round(refreshLatencies[49] ?? 0),
        refreshP95Ms: Math.round(refreshLatencies[94] ?? 0),
        refreshP99Ms: Math.round(refreshLatencies[98] ?? 0),
        ...counts,
        authority: "Dynamo HEAD/chunks and team SCORE rows; fresh repository per request",
        ...nativeMeasurement(fixture),
      }),
    );
  } finally {
    document.middlewareStack.remove("nativePollingMeasurement");
  }
}
async function nativeFailureBoundaries(fixture: NativeFixture) {
  const team = fixture.roster[0];
  assert.ok(team);
  const before = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(before);
  let failure: "before" | "after" | undefined = "before";
  document.middlewareStack.add(
    (next, context) => async (args) => {
      if (
        !["TransactWriteCommand", "TransactWriteItemsCommand"].includes(
          context.commandName ?? "",
        ) ||
        !failure
      )
        return next(args);
      const candidates = z
        .object({
          TransactItems: z.array(
            z.object({ Put: z.object({ Item: z.record(z.unknown()) }).optional() }).passthrough(),
          ),
        })
        .parse(args.input);
      if (!candidates.TransactItems.some((item) => item.Put?.Item.SK === "HEAD")) return next(args);
      const when = failure;
      failure = undefined;
      if (when === "before") throw new Error("synthetic interruption before commit");
      await next(args);
      throw new Error("synthetic lost response after commit");
    },
    { step: "initialize", name: "nativeCommitInterruption" },
  );
  try {
    await assert.rejects(
      () => nativeMove(fixture, team, { kind: "penalty" }, "native-before-commit"),
      /before commit/u,
    );
    assert.equal(
      (await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId))?.revision,
      before.revision,
    );
    failure = "after";
    await assert.rejects(
      () => nativeMove(fixture, team, { kind: "penalty" }, "native-after-commit"),
      /after commit/u,
    );
    const replay = await nativeMove(fixture, team, { kind: "penalty" }, "native-after-commit");
    assert.equal(replay.status, 200);
    assert.equal(
      (await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId))?.match
        .scores[team.teamId],
      2,
    );
    await assert.rejects(
      () => nativeMove(fixture, team, { kind: "point" }, "native-after-commit"),
      /idempotency_key_reused/u,
    );
    const rejected = await nativeMove(fixture, team, { kind: "reject" }, "native-rejected-op");
    assert.equal(rejected.status, 422);
    assert.deepEqual(
      await nativeMove(fixture, team, { kind: "reject" }, "native-rejected-op"),
      rejected,
    );
  } finally {
    document.middlewareStack.remove("nativeCommitInterruption");
  }
  assert.equal(
    await fixture.repo.rotateTeamAccess(team, randomBytes(32).toString("base64url"), at),
    "updated",
  );
  const rotated = await fixture.repo.getTeam(team.eventId, team.teamId);
  assert.ok(rotated);
  await assert.rejects(
    () => nativeMove(fixture, team, { kind: "point" }, "native-revoked-key"),
    /unauthorized/u,
  );
  fixture.roster[0] = rotated;
  const lock = await nativeOrganizer(fixture, "/lock-scoring");
  assert.equal(lock.status, 200, await lock.clone().text());
  await assert.rejects(
    () => nativeMove(fixture, rotated, { kind: "point" }, "native-locked-op"),
    /scoring_locked/u,
  );
  assert.equal((await nativeOrganizer(fixture, "/lock-scoring", "DELETE")).status, 200);
  const rows = await nativeRows(fixture);
  const chunks = rows.filter((row) => String(row.SK).startsWith("SNAPSHOT#"));
  assert.equal(chunks.length, 4);
  assert.ok(rows.some((row) => String(row.SK).startsWith("SCORE#")));
  const history = await fixture
    .store()
    .listScoreEvents(fixture.source.eventId, fixture.artifact.problemId, rotated.teamId);
  assert.ok(history.some((row) => row.points === -2));
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-native-recovery-boundaries",
      beforeCommit: "no partial writes",
      lostResponse: "one signed penalty and exact receipt replay",
      changedBody: "rejected",
      rejectedOperation: "durable422 receipt",
      revokedKey: "rejected",
      scoringLock: "rejected; unlock resumes",
      fixedSnapshotChunks: chunks.length,
      hiddenMatchSecret: "not returned in participant projections",
    }),
  );
}
function isNativePublication(input: unknown): boolean {
  const parsed = z
    .object({
      TransactItems: z
        .array(
          z.object({ Put: z.object({ Item: z.record(z.unknown()) }).optional() }).passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .parse(input);
  return parsed.TransactItems?.some((item) => item.Put?.Item.SK === "HEAD") ?? false;
}
async function beforeNativePublication<T>(
  before: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  let pending = true;
  document.middlewareStack.add(
    (next) => async (args) => {
      if (pending && isNativePublication(args.input)) {
        pending = false;
        await before();
      }
      return next(args);
    },
    { step: "initialize", name: "nativePublicationRace" },
  );
  try {
    return await action();
  } finally {
    document.middlewareStack.remove("nativePublicationRace");
  }
}
async function nativeAdmissionBoundaries(fixture: NativeFixture, advance: () => void) {
  let team = fixture.roster[0];
  assert.ok(team);
  const key = coordinationHeadKey(fixture.source.eventId, fixture.artifact.problemId);
  const crashedOwner = randomUUID();
  await document.send(
    new UpdateCommand({
      TableName: fixture.names.deployments,
      Key: key,
      UpdateExpression: "SET admissionOwner = :owner, admissionExpiresAt = :until",
      ExpressionAttributeValues: { ":owner": crashedOwner, ":until": fixture.clock() + 5000 },
    }),
  );
  advance();
  await nativeMove(fixture, team, { kind: "point" }, "native-expired-admission");
  const reclaimed = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(reclaimed);
  let raw = await document.send(
    new GetCommand({ TableName: fixture.names.deployments, Key: key, ConsistentRead: true }),
  );
  assert.equal(raw.Item?.admissionOwner, undefined);
  const replacement = randomUUID();
  const staleTeam = team;
  const staleClock = fixture.clock();
  await assert.rejects(
    () =>
      beforeNativePublication(
        async () => {
          await document.send(
            new UpdateCommand({
              TableName: fixture.names.deployments,
              Key: key,
              UpdateExpression: "SET admissionOwner = :owner, admissionExpiresAt = :until",
              ExpressionAttributeValues: {
                ":owner": replacement,
                ":until": fixture.clock() + 5000,
              },
            }),
          );
        },
        () =>
          nativeMove(
            fixture,
            staleTeam,
            { kind: "point" },
            "native-replaced-owner",
            () => staleClock,
          ),
      ),
    /coordination_conflict/u,
  );
  raw = await document.send(
    new GetCommand({ TableName: fixture.names.deployments, Key: key, ConsistentRead: true }),
  );
  assert.equal(
    raw.Item?.admissionOwner,
    replacement,
    "Stale release must not erase replacement ownership",
  );
  assert.equal(
    (await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId))?.revision,
    reclaimed.revision,
  );
  await document.send(
    new UpdateCommand({
      TableName: fixture.names.deployments,
      Key: key,
      UpdateExpression: "REMOVE admissionOwner, admissionExpiresAt",
      ConditionExpression: "admissionOwner = :owner",
      ExpressionAttributeValues: { ":owner": replacement },
    }),
  );
  await nativeMove(fixture, team, { kind: "point" }, "native-replaced-owner");
  const beforeRevocation = await fixture
    .store()
    .read(fixture.source.eventId, fixture.artifact.problemId);
  const revoked = team;
  await assert.rejects(
    () =>
      beforeNativePublication(
        async () => {
          assert.equal(
            await fixture.repo.rotateTeamAccess(revoked, randomBytes(32).toString("base64url"), at),
            "updated",
          );
        },
        () => nativeMove(fixture, revoked, { kind: "point" }, "native-admitted-revocation"),
      ),
    /unauthorized/u,
  );
  assert.equal(
    (await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId))?.revision,
    beforeRevocation?.revision,
  );
  team = await fixture.repo.getTeam(team.eventId, team.teamId);
  assert.ok(team);
  fixture.roster[0] = team;
  const currentTeam = team;
  await assert.rejects(
    () =>
      beforeNativePublication(
        async () => {
          await fixture.store().changeSchedule({
            event: await nativeCurrent(fixture),
            artifact: fixture.artifact,
            patch: {
              status: "TEARDOWN",
              endsAt: new Date(fixture.clock()).toISOString(),
              scoringLocked: true,
            },
            now: fixture.clock,
            close: true,
          });
        },
        () => nativeMove(fixture, currentTeam, { kind: "point" }, "native-admitted-close"),
      ),
    /event_changed/u,
  );
  const closed = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(closed?.closed);
  assert.deepEqual(closed.match.scores, beforeRevocation?.match.scores);
  raw = await document.send(
    new GetCommand({ TableName: fixture.names.deployments, Key: key, ConsistentRead: true }),
  );
  assert.equal(raw.Item?.admissionOwner, undefined);
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-native-admission-fences",
      interruptedOwner: "expired claim reacquired",
      replacedOwner: "late publication rejected; replacement lease preserved",
      revocationBeforeCommit: "rejected without score/receipt",
      closeBeforeCommit: "settles run and fences admitted writer",
      successfulRelease: "same transaction as state/score/receipt",
      syntheticDataOnly: true,
    }),
  );
}

async function nativeStaggeredPolling(
  fixture: NativeFixture,
  slotsPerParticipant = 1,
): Promise<void> {
  const streams = 100 * slotsPerParticipant;
  const requestCount = streams * 3;
  const offsetStep = 5000 / streams;
  const started = performance.now();
  const before = { ...fixture.io };
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let responseBytes = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: requestCount }, async (_, index) => {
      const stream = index % streams;
      const participant = stream % 100;
      const round = Math.floor(index / streams);
      const team = fixture.roster[participant % 25];
      assert.ok(team);
      const due = round * 5000 + stream * offsetStep;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, due - (performance.now() - started))),
      );
      const at = performance.now();
      const result = await fixture.app().request("/portal/me/coordination/projection", {
        headers: { authorization: `Bearer ${team.teamLoginKey}` },
      });
      latencies.push(performance.now() - at);
      statuses[String(result.status)] = (statuses[String(result.status)] ?? 0) + 1;
      responseBytes += Buffer.byteLength(await result.text());
      assert.ok(
        result.status === 200 || result.status === 409,
        `Unexpected canonical poll status${result.status}`,
      );
    }),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  nativeCapacityMet &&= (statuses["200"] ?? 0) === requestCount;
  latencies.sort((a, b) => a - b);
  const run = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(run);
  const total = Object.values(run.match.scores).reduce((a, b) => a + b, 0);
  assert.equal(total, 10, "Polling cannot duplicate the one legitimate LEAK award");
  assert.equal(
    (await fixture.repo.listTeamScores(fixture.source.eventId)).reduce(
      (a, row) => a + row.score,
      0,
    ),
    total,
  );
  console.log(
    JSON.stringify({
      milestone:
        slotsPerParticipant === 1
          ? "real-dynamodb-canonical-staggered-polling"
          : "real-dynamodb-canonical-help-open-polling",
      participants: 100,
      teams: 25,
      cycles: 3,
      slotsPerParticipant,
      perClientIntervalMs: 5000,
      deterministicOffsetStepMs: offsetStep,
      requests: requestCount,
      elapsedMs: Math.round(performance.now() - started),
      p50Ms: Math.round(latencies[Math.ceil(requestCount * 0.5) - 1] ?? 0),
      p95Ms: Math.round(latencies[Math.ceil(requestCount * 0.95) - 1] ?? 0),
      p99Ms: Math.round(latencies[Math.ceil(requestCount * 0.99) - 1] ?? 0),
      statuses,
      responseBytes,
      readBinaryBytes: fixture.io.readBinaryBytes - before.readBinaryBytes,
      attemptedWriteBinaryBytes:
        fixture.io.attemptedWriteBinaryBytes - before.attemptedWriteBinaryBytes,
      sdkCommands: fixture.io.commands - before.commands,
      failedSdkCommands: fixture.io.failedCommands - before.failedCommands,
      exactlyOnceTotalScore: total,
      scope:
        "Steady staggered profile; independent of the simultaneous-refresh burst result; no AWS capacity/cost claim",
    }),
  );
}

function verifyCanonicalClockSemantics(plugin: HostPlugin, raw: unknown, teamId: string): void {
  const tick = plugin.tick;
  const scores = plugin.teamScores;
  assert.ok(tick && scores);
  const start = z.object({ startedAtMs: z.number() }).passthrough().parse(raw).startedAtMs;
  const first = tick(structuredClone(raw), start + 5000);
  const clockChained = tick(first, start + 10000);
  const clockDirect = tick(structuredClone(raw), start + 10000);
  assert.equal(
    contentDigest(JSON.stringify(clockChained)),
    contentDigest(JSON.stringify(clockDirect)),
  );
  const chained = tick(tick(structuredClone(raw), start + 60000), start + 600000);
  const direct = tick(structuredClone(raw), start + 600000);
  assert.equal(scores(chained)[teamId], 0);
  assert.equal(scores(direct)[teamId], 10);
  console.log(
    JSON.stringify({
      milestone: "canonical-tick-semigroup-counterexample",
      clockOnlySampleEqual: true,
      meaningfulIntermediateTickMs: 60000,
      finalTickMs: 600000,
      chainedScore: 0,
      skippedTickScore: 10,
      guardrail: "Do not round time or elide meaningful ticks; unseen-Order expiry changes scoring",
    }),
  );
}

async function nativeCanonicalGame(names: typeof tables) {
  const bundled = nativeBattleArtifact(new URL("../..", import.meta.url).pathname);
  const scratch = mkdtempSync(join(tmpdir(), "tenkacloud-canonical-native-"));
  const moduleFile = join(scratch, `${bundled.descriptor.artifactDigest}.mjs`);
  writeFileSync(moduleFile, bundled.source);
  let loaded: { default: HostPlugin };
  try {
    loaded = (await import(pathToFileURL(moduleFile).href)) as { default: HostPlugin };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const fixture = await nativeFixture(
    names,
    25,
    loaded.default,
    {
      ...bundled.descriptor,
      problemDir: "problems/battles/ac26-crypto-battle",
      catalogKey: `catalogs/${contentDigest("canonical-native-acceptance")}.json`,
    },
    () => Date.now(),
  );
  await initializeNative(fixture);
  // Exercise the unchanged real reducer against the real transactional adapter.
  for (const [index, team] of fixture.roster.entries())
    assert.equal(
      (await nativeMove(fixture, team, { kind: "ready" }, `canonical-ready-${index}`)).status,
      200,
    );
  const team = fixture.roster[0];
  assert.ok(team);
  const projection = await fixture.store().request({
    event: await nativeCurrent(fixture),
    team,
    artifact: fixture.artifact,
    now: fixture.clock,
  });
  assert.equal(projection.status, 200);
  const serialized = JSON.stringify(projection.body);
  const state = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(state);
  assert.ok(!serialized.includes(state.match.matchSecret));
  assert.equal(state.roster.length, 25);
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-canonical-initial-state",
      teams: 25,
      readyOperations: 25,
      actualStateBytes: Buffer.byteLength(JSON.stringify(state.match)),
      ...nativeMeasurement(fixture),
    }),
  );
  const contracts = z
    .object({
      contracts: z.array(
        z.object({ id: z.string(), teamId: z.string(), allowedMethods: z.array(z.string()) }),
      ),
    })
    .parse(state.match.state).contracts;
  const own = contracts.find(
    (contract) => contract.teamId === team.teamId && contract.allowedMethods.includes("leak"),
  );
  assert.ok(own, "The canonical opening share Order must remain playable");
  const leak = { kind: "leak", contractId: own.id };
  const result = await nativeMove(fixture, team, leak, "canonical-first-leak");
  assert.equal(result.status, 200);
  assert.equal(
    contentDigest(JSON.stringify(await nativeMove(fixture, team, leak, "canonical-first-leak"))),
    contentDigest(JSON.stringify(result)),
  );
  const after = await fixture.store().read(fixture.source.eventId, fixture.artifact.problemId);
  assert.ok(after);
  const awarded = after.match.scores[team.teamId];
  assert.ok(awarded !== undefined && awarded > 0);
  verifyCanonicalClockSemantics(loaded.default, after.match.state, team.teamId);
  assert.equal(
    (await fixture.repo.listTeamScores(fixture.source.eventId)).find(
      (row) => row.teamId === team.teamId,
    )?.score,
    awarded,
  );
  const other = fixture.roster[1];
  assert.ok(other);
  assert.equal((await nativeMove(fixture, other, leak, "canonical-foreign-order")).status, 422);
  await nativePolling(fixture, true);
  await nativeStaggeredPolling(fixture);
  await nativeStaggeredPolling(fixture, 2);
  assert.equal((await nativeOrganizer(fixture, "/end")).status, 200);
  await assert.rejects(
    () => nativeMove(fixture, team, { kind: "ready" }, "canonical-after-end"),
    /event_ended/u,
  );
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-canonical-crypto-battle",
      teams: 25,
      readyOperations: 25,
      pluginBundleBytes: Buffer.byteLength(bundled.source),
      stateBytes: Buffer.byteLength(JSON.stringify(state.match)),
      declared25TeamBudget: 31744 * 25 + 1536,
      schemaVersion: state.match.stateSchemaVersion,
      revision: state.revision,
      pluginDigest: bundled.descriptor.artifactDigest,
      operations:
        "canonical ready, own LEAK, duplicate receipt, foreign Order refusal, organizer END and final projection",
      firstLeakAward: awarded,
      ...nativeMeasurement(fixture),
    }),
  );
  return fixture;
}
async function closeNative(fixture: NativeFixture) {
  const result = await nativeOrganizer(fixture, "", "DELETE");
  assert.equal(result.status, 202, await result.clone().text());
  const source = await nativeCurrent(fixture);
  assert.equal(source.status, "ARCHIVED");
  assert.equal(source.teardownExpected, 0);
  assert.equal(source.teardownCompleted, 0);
  assert.equal(
    (await fixture.store().read(source.eventId, fixture.artifact.problemId))?.closed,
    true,
  );
  assert.equal((await nativeOrganizer(fixture, "", "DELETE")).status, 200);
}
async function verifyNativeCoordination(): Promise<void> {
  const names = {
    events: `${prefix}-native-events`,
    teams: `${prefix}-native-teams`,
    deployments: `${prefix}-native-deployments`,
  };
  await createTables(names);
  const canonical = await nativeCanonicalGame(names);
  let nativeOffset = 0;
  const fixture = await nativeFixture(
    names,
    25,
    syntheticNativePlugin(795136),
    undefined,
    () => Date.now() + nativeOffset,
  );
  const initial = await initializeNative(fixture);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(initial.match));
  assert.ok(snapshotBytes > 795136);
  await nativeClientLoad(fixture);
  await nativePolling(fixture);
  await nativeFailureBoundaries(fixture);
  await nativeAdmissionBoundaries(fixture, () => {
    nativeOffset += 6000;
  });
  const maximum = await nativeFixture(names, 48, syntheticNativePlugin(1536 + 31744 * 48));
  await initializeNative(maximum);
  const team = maximum.roster[0];
  assert.ok(team);
  assert.equal(
    (await nativeMove(maximum, team, { kind: "all" }, "native-maximum-roster")).status,
    200,
  );
  assert.equal((await maximum.repo.listTeamScores(maximum.source.eventId)).length, 48);
  const largest = maximum.measurements.reduce((a, b) =>
    a.bytesUpperBound > b.bytesUpperBound ? a : b,
  );
  assert.ok(
    largest.items <= 100 &&
      largest.maxItemBytes < 400 * 1024 &&
      largest.bytesUpperBound < 4 * 1024 * 1024,
  );
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-native-transaction-bounds",
      synthetic25TeamSnapshotBytes: snapshotBytes,
      maximumSupportedTeams: 48,
      changedScoreRows: 48,
      ...largest,
      snapshot: "fixed slots, HEAD CAS, score map ledger and response receipt commit together",
    }),
  );
  const scope = {
    environment: "dev",
    account: "123456789012",
    region: "us-east-1",
    applicationStackId:
      "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-dev/00000000-0000-0000-0000-000000000001",
    backendStackId:
      "arn:aws:cloudformation:us-east-1:123456789012:stack/tenkacloud-cloud-problem-deploy-dev/00000000-0000-0000-0000-000000000002",
  };
  await fixture.repo.stopAcceptingInstallation(scope, at);
  await assert.rejects(
    () => nativeMove(maximum, team, { kind: "point" }, "native-after-stop"),
    /coordination_conflict/u,
  );
  const stillOpen = await nativeCurrent(maximum);
  await assert.rejects(
    () => maximum.operations.closeEvent(stillOpen, at),
    /coordination_not_settled/u,
  );
  for (const current of [fixture, maximum, canonical]) await closeNative(current);
  await fixture.repo.confirmInstallationDrained(scope, at);
  await fixture.repo.confirmInstallationDrained(scope, at);
  assert.equal((await fixture.repo.installationControl())?.status, "DRAINED");
  console.log(
    JSON.stringify({
      milestone: "real-dynamodb-native-global-drain",
      nativeEvents: 3,
      awsTargets: 0,
      retainedScores: (await fixture.repo.listTeamScores(fixture.source.eventId)).reduce(
        (sum, row) => sum + row.score,
        0,
      ),
      outcome:
        "all native snapshots settled before ARCHIVED and DRAINED; interrupted/repeated DELETE safe",
      scope: "Synthetic data, existing three-table schema, no AWS exercise or account connection",
    }),
  );
}

const nativeOnly = process.argv[3] === "--native-only";
const accountsOnly = process.argv[3] === "--accounts-only";
if (process.argv.length > 4 || (process.argv[3] !== undefined && !nativeOnly && !accountsOnly))
  throw new Error(
    "Only --native-only or --accounts-only focused acceptance selectors are supported.",
  );
try {
  if (accountsOnly) {
    await createTables();
    await verifyAccountClients();
  } else if (!nativeOnly) {
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
    await verifyHistoricalTeardownConcurrency();
    await verifyAccountClients();
    await verifyParticipantCliAuthorization();
    await verifyInstallationStopAndDrain();
  }
  if (!accountsOnly) await verifyNativeCoordination();
  console.log(
    JSON.stringify({
      outcome: nativeCapacityMet ? "passed" : "consistency-passed-capacity-unmet",
      target: "official DynamoDB Local, synthetic work, no AWS execution",
    }),
  );
  if (!nativeCapacityMet) process.exitCode = 2;
} finally {
  try {
    for (const TableName of createdTables) await client.send(new DeleteTableCommand({ TableName }));
  } finally {
    client.destroy();
  }
}
