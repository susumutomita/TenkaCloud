import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCloudInstallation } from "../../../scripts/cloud-hosting/installation.js";
import { createCloudDataCache } from "../../lib/problem-deploy/control-data/cloud-data.js";
import type { CloudData } from "../../lib/problem-deploy/control-data/cloud-data-ports.js";
import {
  contentDigest,
  type DeploymentJob,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { DynamoCloudRepository } from "../../lib/problem-deploy/control-data/dynamodb-cloud-repository.js";
import { DynamoDbCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "../../lib/problem-deploy/control-data/dynamodb-deployment-work.js";
import { DynamoDeploymentsCoordination } from "../../lib/problem-deploy/control-data/dynamodb-deployments-coordination.js";
import { SqlCloudRepository } from "../../lib/problem-deploy/control-data/sql-cloud-repository.js";
import { SqlCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/sql-competitor-accounts-repository.js";
import { SqlDeploymentWork } from "../../lib/problem-deploy/control-data/sql-deployment-work.js";
import { SqlDeploymentsCoordination } from "../../lib/problem-deploy/control-data/sql-deployments-coordination.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import { createProductionNativeCoordination } from "../../lib/problem-deploy/handlers/cloud-api/native-production.js";
import { sqlHttpFixture } from "./sql-http-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const env = {
  CONTROL_DATA_BACKEND: "turso",
  TURSO_DATABASE_URL: "https://fixture.invalid",
  TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/turso/auth-token",
};
const tables = {
  events: "fixture-events",
  teams: "fixture-teams",
  deployments: "fixture-deployments",
};
const now = Date.parse("2026-10-01T12:00:00.000Z");
const at = new Date(now).toISOString();
const event: EventRecord = {
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA0",
  name: "Runtime fixture",
  status: "READY",
  teamCount: 1,
  problems: [{ problemId: "one", defaultRegion: "us-east-1" }],
  createdAt: at,
  updatedAt: at,
  expiresAt: now / 1000 + 86400,
};
const team: TeamRecord = {
  eventId: event.eventId,
  teamId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  internalSlug: "fixture-team",
  teamLoginKey: "A".repeat(43),
  authVersion: 1,
  accessRevoked: false,
  createdAt: at,
  updatedAt: at,
  expiresAt: event.expiresAt,
};
const apiRequest: Parameters<
  typeof import("../../lib/problem-deploy/handlers/cloud-api/index.js").handler
>[0] = {
  version: "2.0",
  routeKey: "$default",
  rawPath: "/events",
  rawQueryString: "",
  headers: {},
  body: null,
  requestContext: {
    accountId: "123456789012",
    apiId: "fixture",
    authentication: null,
    authorizer: {},
    domainName: "fixture.invalid",
    domainPrefix: "fixture",
    requestId: "fixture",
    routeKey: "$default",
    stage: "$default",
    time: at,
    timeEpoch: now,
    http: {
      method: "GET",
      path: "/events",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "fixture",
    },
  },
  isBase64Encoded: false,
};
const apiContext: Parameters<
  typeof import("../../lib/problem-deploy/handlers/cloud-api/index.js").handler
>[1] = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "fixture",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:fixture",
  memoryLimitInMB: "512",
  awsRequestId: "fixture",
  logGroupName: "fixture",
  logStreamName: "fixture",
  getRemainingTimeInMillis: () => 1000,
};
function sqlFixture() {
  const f = sqlHttpFixture();
  cleanups.push(f.close);
  vi.stubGlobal("fetch", f.fetch);
  const send = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
    Parameter: { Type: "SecureString", Value: "synthetic-token" },
  }));
  const dynamo = vi.spyOn(DynamoDBDocumentClient, "from");
  const dynamoSend = vi
    .spyOn(DynamoDBClient.prototype, "send")
    .mockRejectedValue(new Error("Unexpected Dynamo call"));
  return { ...f, send, dynamo, dynamoSend };
}
function tracked(data: CloudData) {
  cleanups.push(data.close);
  return data;
}
async function checkRegion(client: unknown) {
  if (!(client instanceof SSMClient) && !(client instanceof DynamoDBDocumentClient))
    throw new Error("Expected intercepted SDK client");
  expect(await client.config.region()).toBe("us-east-1");
  expect(client.config.ignoreConfiguredEndpointUrls).toBe(true);
}

describe("shared cloud provider composition", () => {
  it("preserves default Dynamo adapters and explicit region without reading Turso credentials", async () => {
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    const ssm = vi
      .spyOn(SSMClient.prototype, "send")
      .mockRejectedValue(new Error("Unexpected SSM call"));
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, "send")
      .mockImplementation(async () => ({ Items: [] }));
    const acquire = createCloudDataCache({ env: {}, region: "us-east-1", tables });
    const data = tracked(await acquire());
    expect(await acquire()).toBe(data);
    expect(data.repository).toBeInstanceOf(DynamoCloudRepository);
    expect(data.work).toBeInstanceOf(DynamoDeploymentWork);
    expect(data.accounts).toBeInstanceOf(DynamoDbCompetitorAccountsRepository);
    expect(data.coordination).toBeInstanceOf(DynamoDeploymentsCoordination);
    expect(await data.repository.listEvents()).toEqual([]);
    const command = send.mock.calls[0]?.[0];
    if (!(command instanceof QueryCommand)) throw new Error("Unexpected command");
    expect(command.input.TableName).toBe(tables.events);
    await checkRegion(send.mock.contexts[0]);
    expect(ssm).not.toHaveBeenCalled();
  });
  it("composes SQL without Dynamo settings or clients and shares concurrent cold starts", async () => {
    const f = sqlFixture();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    const acquire = createCloudDataCache({ env, region: "us-east-1" });
    const [first, second] = await Promise.all([acquire(), acquire()]);
    const data = tracked(first);
    expect(second).toBe(data);
    expect(await acquire()).toBe(data);
    expect(data.repository).toBeInstanceOf(SqlCloudRepository);
    expect(data.work).toBeInstanceOf(SqlDeploymentWork);
    expect(data.accounts).toBeInstanceOf(SqlCompetitorAccountsRepository);
    expect(data.coordination).toBeInstanceOf(SqlDeploymentsCoordination);
    await data.repository.createEventWithTeams(event, [team]);
    expect(await data.repository.getEvent(event.eventId)).toEqual(event);
    expect(await data.work.acceptingNewDeployments()).toBe(true);
    expect(await data.accounts.listAccounts()).toEqual([]);
    expect(await data.coordination.read(event.eventId, "ac26-crypto-battle")).toBeUndefined();
    expect(f.send).toHaveBeenCalledOnce();
    const command = f.send.mock.calls[0]?.[0];
    if (!(command instanceof GetParameterCommand)) throw new Error("Unexpected command");
    expect(command.input).toEqual({
      Name: env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
      WithDecryption: true,
    });
    await checkRegion(f.send.mock.contexts[0]);
    expect(f.dynamo).not.toHaveBeenCalled();
    expect(f.dynamoSend).not.toHaveBeenCalled();
  });
  it("rejects invalid selection/settings and retries SQL initialization without fallback", async () => {
    const f = sqlFixture();
    expect(() => createCloudDataCache({ env: { CONTROL_DATA_BACKEND: "sqlite" } })).toThrow(
      "Unknown CONTROL_DATA_BACKEND",
    );
    await expect(createCloudDataCache({ env: {} })()).rejects.toThrow("EVENTS_TABLE_NAME");
    await expect(
      createCloudDataCache({ env: { CONTROL_DATA_BACKEND: "turso" } })(),
    ).rejects.toThrow("TURSO_DATABASE_URL");
    expect(f.send).not.toHaveBeenCalled();
    f.send.mockRejectedValueOnce(new Error("fixture SSM unavailable"));
    const acquire = createCloudDataCache({ env, region: "us-east-1" });
    await expect(acquire()).rejects.toThrow("fixture SSM unavailable");
    expect(tracked(await acquire()).repository).toBeInstanceOf(SqlCloudRepository);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.dynamo).not.toHaveBeenCalled();
  });
  it("uses SQL through the unchanged API authentication boundary and native production wrapper", async () => {
    const f = sqlFixture();
    const data = tracked(await createCloudDataCache({ env, region: "us-east-1" })());
    await data.repository.createEventWithTeams(event, [team]);
    const native = createProductionNativeCoordination({
      repository: data.repository,
      store: data.coordination,
      artifactBucket: "fixture-artifacts",
      expectedBucketOwner: "123456789012",
      region: "us-east-1",
      catalogKey: `catalogs/${"a".repeat(64)}.json`,
    });
    expect(native.store).toBe(data.coordination);
    expect(await native.closeEvent(event.eventId, now)).toEqual(event);
    const app = createCloudApp({
      repository: data.repository,
      now: () => now,
      organizerAuth: { issuer: "https://fixture.invalid", audience: "fixture-audience" },
      allowedOrigins: [],
    });
    expect((await app.request("/events")).status).toBe(401);
    expect((await app.request("/portal/me")).status).toBe(401);
    const response = await app.request("/portal/me", {
      headers: { Authorization: `Bearer ${team.teamLoginKey}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ team: { teamId: team.teamId } });
    await data.repository.rotateTeamAccess(team, undefined, at);
    expect(
      (
        await app.request("/portal/me", {
          headers: { Authorization: `Bearer ${team.teamLoginKey}` },
        })
      ).status,
    ).toBe(401);
    expect(f.dynamo).not.toHaveBeenCalled();
  });
  it("opens the operator SQL installation in its chosen region without Dynamo table names", async () => {
    const f = sqlFixture();
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    const installation = await openCloudInstallation({
      region: "us-east-1",
      backend: "turso",
      turso: {
        databaseUrl: env.TURSO_DATABASE_URL,
        authTokenParameterName: env.TURSO_AUTH_TOKEN_PARAMETER_NAME,
      },
    });
    cleanups.push(installation.close);
    await expect(installation.repository.assertAcceptingInstallation()).resolves.toBeUndefined();
    await checkRegion(f.send.mock.contexts[0]);
    expect(f.dynamo).not.toHaveBeenCalled();
  });
  it("keeps the existing operator Dynamo path and explicit selected region", async () => {
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, "send")
      .mockImplementation(async () => ({}));
    const installation = await openCloudInstallation({ region: "us-east-1", tables });
    cleanups.push(installation.close);
    await expect(installation.repository.assertAcceptingInstallation()).resolves.toBeUndefined();
    const command = send.mock.calls[0]?.[0];
    if (!(command instanceof GetCommand)) throw new Error("Unexpected command");
    expect(command.input).toMatchObject({
      TableName: tables.events,
      ConsistentRead: true,
    });
    await checkRegion(send.mock.contexts[0]);
  });
});

describe("production Lambda provider selection", () => {
  it.each(
    (["dynamodb", "turso"] as const).flatMap((backend) =>
      (["changed", "removed"] as const).map((current) => ({ backend, current })),
    ),
  )(
    "composes captured participant artifacts with $backend after current catalog is $current",
    async ({ backend, current }) => {
      vi.resetModules();
      sqlFixture();
      const bindings = "[]";
      const captured = {
        problemId: "hello-world",
        problemDir: "problems/challenges/hello-world",
        templateBody: "Resources: {} # captured A",
        artifactDigest: contentDigest("Resources: {} # captured A"),
        scoring: {
          kind: "flag" as const,
          points: 100,
          flagOutputKey: "ExpectedFlag",
          wrongPenalty: 0,
        },
        parameters: {},
        capabilities: ["CAPABILITY_NAMED_IAM" as const],
        publicOutputKeys: ["ParameterName", "ParticipantViewerRoleArn"],
      };
      const rawA = JSON.stringify({ version: 1, problems: [captured] });
      const rawB = JSON.stringify({
        version: 1,
        problems: [
          {
            ...captured,
            ...(current === "removed"
              ? { problemId: "other", problemDir: "problems/challenges/other" }
              : {}),
            templateBody: "Resources: {} # current B",
            artifactDigest: contentDigest("Resources: {} # current B"),
          },
        ],
      });
      const keyA = `catalogs/${contentDigest(rawA)}.json`;
      const keyB = `catalogs/${contentDigest(rawB)}.json`;
      const bindingsKey = `bindings/${contentDigest(bindings)}.json`;
      const objects = new Map([
        [keyA, rawA],
        [keyB, rawB],
        [bindingsKey, bindings],
      ]);
      const reads = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
        if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 command");
        expect(command.input).toMatchObject({
          Bucket: "fixture-artifacts",
          ExpectedBucketOwner: "123456789012",
        });
        const raw = objects.get(command.input.Key ?? "");
        if (raw === undefined) throw new Error("Unexpected artifact read");
        return {
          ContentLength: Buffer.byteLength(raw),
          Body: { transformToString: async () => raw },
        };
      });
      const selectedTables =
        backend === "dynamodb" ? tables : { events: "", teams: "", deployments: "" };
      for (const [key, value] of Object.entries({
        ...env,
        CONTROL_DATA_BACKEND: backend,
        AWS_REGION: "us-east-1",
        CONTROL_PLANE_ACCOUNT: "123456789012",
        COGNITO_ISSUER: "https://fixture.invalid",
        COGNITO_CLIENT_ID: "fixture-client",
        ALLOWED_ORIGINS: "https://fixture.invalid",
        CLOUD_CATALOG_KEY: keyB,
        COMPETITOR_ROLE_NAME: "",
        CLOUD_ARTIFACT_BUCKET: "fixture-artifacts",
        CLOUD_RUNNER_BINDINGS_KEY: bindingsKey,
        EVENTS_TABLE_NAME: selectedTables.events,
        TEAMS_TABLE_NAME: selectedTables.teams,
        DEPLOYMENTS_TABLE_NAME: selectedTables.deployments,
      }))
        vi.stubEnv(key, value);
      const appModule = await import("../../lib/problem-deploy/handlers/cloud-api/app.js");
      // Observe the real factory call; keep the production handler and app composition intact.
      const composed = vi.spyOn(appModule, "createCloudApp");
      const { handler: api } = await import("../../lib/problem-deploy/handlers/cloud-api/index.js");
      expect((await api(apiRequest, apiContext)).statusCode).toBe(401);
      const { acquireCloudData } = await import(
        "../../lib/problem-deploy/control-data/cloud-data.js"
      );
      const data = tracked(await acquireCloudData());
      expect(data.work.constructor.name).toBe(
        backend === "dynamodb" ? "DynamoDeploymentWork" : "SqlDeploymentWork",
      );
      const access = composed.mock.calls[0]?.[0].participantAccess;
      if (!access) throw new Error("Production participant access was not composed");
      const job: DeploymentJob = {
        eventId: event.eventId,
        teamId: team.teamId,
        jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        problemId: captured.problemId,
        problemDir: captured.problemDir,
        artifactDigest: captured.artifactDigest,
        catalogKey: keyA,
        scoring: captured.scoring,
        awsAccountId: "111111111111",
        region: "us-east-1",
        status: "COMPLETE",
        attempt: 1,
        revision: 1,
        score: 0,
        stackName: "captured-stack",
        createdAt: at,
        updatedAt: at,
        expiresAt: event.expiresAt,
        connection: {
          eventId: event.eventId,
          teamId: team.teamId,
          accountId: "111111111111",
          region: "us-east-1",
          roleArn: "arn:aws:iam::111111111111:role/fixture",
          externalIdParameter: "arn:aws:ssm:us-east-1:123456789012:parameter/fixture",
          version: 1,
          verifiedAt: at,
        },
      };
      await expect(access.resolveArtifacts(job)).resolves.toEqual({
        templateBody: captured.templateBody,
        artifactDigest: captured.artifactDigest,
        capabilities: captured.capabilities,
        publicOutputKeys: captured.publicOutputKeys,
      });
      expect(
        reads.mock.calls.map(([command]) =>
          command instanceof GetObjectCommand ? command.input.Key : undefined,
        ),
      ).toEqual([bindingsKey, keyA]);
    },
  );

  it.each(["dynamodb", "turso"] as const)(
    "uses %s in API, dispatcher, recovery and worker entry points",
    async (backend) => {
      vi.resetModules();
      const f = sqlFixture();
      const documentSend = vi
        .spyOn(DynamoDBDocumentClient.prototype, "send")
        .mockImplementation(async () => ({ Items: [] }));
      const sfn = vi
        .spyOn(SFNClient.prototype, "send")
        .mockRejectedValue(new Error("Unexpected execution"));
      const bindings = "[]";
      vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({
        ContentLength: bindings.length,
        Body: { transformToString: async () => bindings },
      }));
      const selectedTables =
        backend === "dynamodb" ? tables : { events: "", teams: "", deployments: "" };
      for (const [key, value] of Object.entries({
        ...env,
        CONTROL_DATA_BACKEND: backend,
        AWS_REGION: "us-east-1",
        CONTROL_PLANE_ACCOUNT: "123456789012",
        COGNITO_ISSUER: "https://fixture.invalid",
        COGNITO_CLIENT_ID: "fixture-client",
        ALLOWED_ORIGINS: "https://fixture.invalid",
        CLOUD_CATALOG_KEY: "",
        COMPETITOR_ROLE_NAME: "",
        CLOUD_ARTIFACT_BUCKET: "fixture-artifacts",
        CLOUD_RUNNER_BINDINGS_KEY: `bindings/${contentDigest(bindings)}.json`,
        DEPLOYMENT_STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:fixture",
        EVENTS_TABLE_NAME: selectedTables.events,
        TEAMS_TABLE_NAME: selectedTables.teams,
        DEPLOYMENTS_TABLE_NAME: selectedTables.deployments,
      }))
        vi.stubEnv(key, value);
      const { acquireCloudData } = await import(
        "../../lib/problem-deploy/control-data/cloud-data.js"
      );
      const { handler: api } = await import("../../lib/problem-deploy/handlers/cloud-api/index.js");
      const result = await api(apiRequest, apiContext);
      expect(result.statusCode).toBe(401);
      tracked(await acquireCloudData());
      const { acquireCloudWork } = await import(
        "../../lib/problem-deploy/control-data/cloud-work-data.js"
      );
      const dispatcher = await import(
        "../../lib/problem-deploy/handlers/cloud-runner/dispatcher.js"
      );
      expect(await dispatcher.handler()).toEqual({
        pending: 0,
        started: 0,
        duplicate: 0,
        uncertain: 0,
      });
      const recovery = await dispatcher.createAwsRecoveryDependencies();
      expect(await recovery.repository.getJob("01ARZ3NDEKTSV4RRFFQ69G5FA2")).toBeUndefined();
      const worker = await import("../../lib/problem-deploy/handlers/cloud-runner/lambda.js");
      const handlers = await worker.createProductionWorkflowHandlers(async () => {
        throw new Error("Unexpected artifact read");
      });
      await expect(
        handlers.claim({
          identity: {
            eventId: event.eventId,
            teamId: team.teamId,
            jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
            attempt: 1,
          },
          owner: "arn:aws:states:us-east-1:123456789012:execution:fixture:fixture",
        }),
      ).rejects.toThrow("could not complete");
      cleanups.push((await acquireCloudWork()).close);
      expect(sfn).not.toHaveBeenCalled();
      if (backend === "turso") {
        expect(f.send).toHaveBeenCalledTimes(2);
        expect(f.dynamo).not.toHaveBeenCalled();
        expect(documentSend).not.toHaveBeenCalled();
        expect(f.dynamoSend).not.toHaveBeenCalled();
      } else {
        expect(f.send).not.toHaveBeenCalled();
        expect(documentSend).toHaveBeenCalled();
      }
    },
  );
});
