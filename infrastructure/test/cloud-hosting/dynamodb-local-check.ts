/** Explicit local-only acceptance. Uses official DynamoDB Local, never AWS or ambient credentials. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";

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
  problems: [{ problemId: "problem-one", defaultRegion: "us-east-1" }],
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
async function verifyAtomicity(): Promise<void> {
  assert.equal(await repository().createEventWithTeams(event, teams), "created");
  assert.equal((await repository().listTeamsByEvent(event.eventId)).length, 25);
  const other: EventRecord = { ...event, eventId: ulid() };
  const colliding = teams.map((team) => ({ ...team, eventId: other.eventId, teamId: ulid() }));
  // Global key-lookup collision must roll back the new event and every team.
  assert.equal(await repository().createEventWithTeams(other, colliding), "conflict");
  assert.equal(await repository().getEvent(other.eventId), undefined);
  assert.equal((await repository().listTeamsByEvent(other.eventId)).length, 0);
  const first = teams[0];
  const second = teams[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(await repository().getTeam(other.eventId, first.teamId), undefined);
  assert.equal(await repository().rotateTeamAccess(first, second.teamLoginKey, at), "conflict");
  assert.equal(
    (await repository().authenticateTeam(first.teamLoginKey, now))?.teamId,
    first.teamId,
  );
  const a = randomBytes(32).toString("base64url");
  const b = randomBytes(32).toString("base64url");
  const results = await Promise.all([
    repository().rotateTeamAccess(first, a, at),
    repository().rotateTeamAccess(first, b, at),
  ]);
  assert.equal(results.filter((result) => result === "updated").length, 1);
  assert.equal(results.filter((result) => result === "conflict").length, 1);
  assert.equal(await repository().authenticateTeam(first.teamLoginKey, now), undefined);
  const winner = results[0] === "updated" ? a : b;
  const loser = results[0] === "updated" ? b : a;
  assert.equal(await repository().authenticateTeam(loser, now), undefined);
  const active = await repository().authenticateTeam(winner, now);
  assert.ok(active);
  assert.equal(active.authVersion, 2);
  assert.equal(await repository().rotateTeamAccess(active, undefined, at), "updated");
  assert.equal(await repository().authenticateTeam(winner, now), undefined);
  const revoked = await repository().getTeam(first.eventId, first.teamId);
  assert.ok(revoked);
  const reissued = randomBytes(32).toString("base64url");
  assert.equal(await repository().rotateTeamAccess(revoked, reissued, at), "updated");
  teams[0] = { ...revoked, teamLoginKey: reissued, authVersion: 4, accessRevoked: false };
  assert.equal((await repository().authenticateTeam(reissued, now))?.authVersion, 4);
  assert.equal(await repository().authenticateTeam(reissued, event.expiresAt * 1000), undefined);
}
async function verifyDeploymentScope(): Promise<void> {
  const first = teams[0];
  assert.ok(first);
  const jobId = ulid();
  await document.send(
    new PutCommand({
      TableName: tables.deployments,
      Item: {
        PK: `DEPLOYMENT#${jobId}`,
        SK: "META",
        GSI1PK: `EVENT#${event.eventId}`,
        GSI1SK: `TEAM#${first.teamId}#PROBLEM#problem-one`,
        jobId,
        eventId: event.eventId,
        teamId: first.teamId,
        problemId: "problem-one",
        region: "us-east-1",
        awsAccountId: "123456789012",
        status: "COMPLETE",
        expiresAt: event.expiresAt,
        score: 42,
      },
    }),
  );
  assert.equal((await repository().listDeploymentsByEvent(event.eventId))[0]?.score, 42);
  assert.equal((await repository().listDeploymentsByEvent(ulid())).length, 0);
}
async function verifyParallelAuthentication() {
  const start = performance.now();
  const latencies: number[] = [];
  await Promise.all(
    teams.flatMap((team) =>
      Array.from({ length: 4 }, async () => {
        const requestStart = performance.now();
        const authenticated = await repository().authenticateTeam(team.teamLoginKey, now);
        assert.equal(authenticated?.eventId, team.eventId);
        assert.equal(authenticated?.teamId, team.teamId);
        latencies.push(performance.now() - requestStart);
      }),
    ),
  );
  latencies.sort((a, b) => a - b);
  return {
    authenticationRequests: latencies.length,
    teams: teams.length,
    durationMs: Math.round(performance.now() - start),
    p50Ms: Math.round(latencies[49] ?? 0),
    p95Ms: Math.round(latencies[94] ?? 0),
  };
}
try {
  await createTables();
  await verifyAtomicity();
  await verifyDeploymentScope();
  console.log(
    JSON.stringify({
      outcome: "passed",
      schema: "historical-event-team-deployment",
      atomicCreationAndKeyRotation: "passed",
      ...(await verifyParallelAuthentication()),
      scope: "local authentication and storage, not scoring capacity or AWS performance",
    }),
  );
} finally {
  try {
    for (const TableName of createdTables) await client.send(new DeleteTableCommand({ TableName }));
  } finally {
    client.destroy();
  }
}
