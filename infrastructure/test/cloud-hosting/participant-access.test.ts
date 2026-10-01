import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import type { CliCredentialsView } from "@tenkacloud/portal-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreationReservation,
  type DeploymentConnection,
  type DeploymentJob,
  deploymentStackName,
  scoringBlock,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";
import { createCloudApp } from "../../lib/problem-deploy/handlers/cloud-api/app.js";
import {
  type CloudParticipantAccess,
  helloWorldSessionPolicy,
} from "../../lib/problem-deploy/handlers/cloud-api/participant-access.js";
import {
  type CloudFormationTransport,
  type CloudRunnerDependencies,
  deploymentIdentity,
  deploymentOwnershipTags,
  type StackDescription,
} from "../../lib/problem-deploy/handlers/cloud-runner/index.js";
import {
  buildDeploymentInput,
  type DeploymentArtifacts,
} from "../../lib/problem-deploy/handlers/cloud-runner/workflow.js";
import { FakeRepository } from "./fake-repository.js";

const NOW = Date.parse("2026-10-01T09:00:00Z");
const AT = new Date(NOW).toISOString();
const EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const TEAM = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const ACCOUNT = "111111111111";
const CONTROL_ACCOUNT = "123456789012";
const VIEWER = "SyntheticParticipantViewer";
const VIEWER_ARN = `arn:aws:iam::${ACCOUNT}:role/${VIEWER}`;
const KEY = "synthetic-team-key-".padEnd(43, "A");
const ACCESS_KEY = "ASIASYNTHETICTEST0001";
const SECRET_KEY = "SyntheticOnlySecretForOfflineTest01234567";
const SESSION_TOKEN = "SyntheticOnlySessionTokenForOfflineTest0123456789";
const DEPLOYMENT_SECRET = "synthetic-deployment-external-id";
const CLI_PATH = `/portal/me/cli-credentials?jobId=${JOB}`;
const CONSOLE_PATH = `/portal/me/console-signin-url?jobId=${JOB}`;
const CLIENT_MODULE = new URL(
  "../../../apps/participant-portal/src/api/portal-client/sso.ts",
  import.meta.url,
).href;
type Work = CloudParticipantAccess["work"];
type Resource = Awaited<ReturnType<NonNullable<CloudFormationTransport["describeStackResource"]>>>;
type RemoteStage = "artifacts" | "stack" | "viewer";

function sameGuardValue(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Atomic participant authorization changed");
}

function credentials(): AssumeRoleCommandOutput {
  return {
    $metadata: {},
    AssumedRoleUser: {
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${VIEWER}/tc-view-${JOB}`,
      AssumedRoleId: `SYNTHETICROLE:tc-view-${JOB}`,
    },
    Credentials: {
      AccessKeyId: ACCESS_KEY,
      SecretAccessKey: SECRET_KEY,
      SessionToken: SESSION_TOKEN,
      Expiration: new Date(NOW + 900_000),
    },
  };
}

function fixture(enabled = true, region = "us-east-1") {
  const repository = new FakeRepository();
  const event: EventRecord = {
    eventId: EVENT,
    name: "Offline participant access test",
    status: "READY",
    teamCount: 1,
    problems: [{ problemId: "hello-world", defaultRegion: "us-east-1" }],
    startsAt: AT,
    endsAt: new Date(NOW + 3_600_000).toISOString(),
    expiresAt: NOW / 1000 + 86400,
    createdAt: AT,
    updatedAt: AT,
  };
  const team: TeamRecord = {
    eventId: EVENT,
    teamId: TEAM,
    internalSlug: "team-a",
    region,
    teamLoginKey: KEY,
    authVersion: 1,
    accessRevoked: false,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
  };
  repository.events.set(EVENT, event);
  repository.teams.set(`${EVENT}/${TEAM}`, team);
  const connection: DeploymentConnection = {
    eventId: EVENT,
    teamId: TEAM,
    accountId: ACCOUNT,
    region,
    roleArn: `arn:aws:iam::${ACCOUNT}:role/SyntheticDeploy`,
    externalIdParameter: `arn:aws:ssm:us-east-1:${CONTROL_ACCOUNT}:parameter/synthetic/team`,
    version: 1,
    verifiedAt: AT,
    registrationId: "synthetic-registration",
    reviewedProblemIds: ["hello-world"],
  };
  const stackName = deploymentStackName(EVENT, TEAM, "hello-world");
  const stackId = `arn:aws:cloudformation:${region}:${ACCOUNT}:stack/${stackName}/original-stack`;
  const job: DeploymentJob = {
    eventId: EVENT,
    teamId: TEAM,
    jobId: JOB,
    problemId: "hello-world",
    problemDir: "problems/challenges/hello-world",
    awsAccountId: ACCOUNT,
    region,
    status: "COMPLETE",
    attempt: 1,
    revision: 2,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: event.expiresAt,
    score: 0,
    stackName,
    stackId,
    artifactDigest: "a".repeat(64),
    completionDigest: "d".repeat(64),
    catalogKey: `catalogs/${"b".repeat(64)}.json`,
    parameters: { NamePrefix: stackName, ExternalId: JOB, TenkaCloudAccountId: CONTROL_ACCOUNT },
    connection,
    scoring: { kind: "flag", points: 100, wrongPenalty: 0, flagOutputKey: "ExpectedFlag" },
    publicOutputs: { ParameterName: `/${stackName}/hello` },
  };
  repository.deployments = [job];
  const artifacts: DeploymentArtifacts = {
    templateBody: "Resources: {}",
    artifactDigest: job.artifactDigest,
    capabilities: ["CAPABILITY_NAMED_IAM"],
    publicOutputKeys: ["ParameterName", "ParticipantViewerRoleArn"],
  };
  const { input } = buildDeploymentInput(job, artifacts);
  const state: {
    now: number;
    job?: DeploymentJob;
    target?: DeploymentJob;
    connection?: DeploymentConnection;
    creation?: CreationReservation;
    stack: StackDescription;
    resource: Resource;
    viewerResponse: AssumeRoleCommandOutput;
    accepting: boolean;
    registered: boolean;
  } = {
    now: NOW,
    job,
    target: job,
    connection,
    creation: {
      eventId: EVENT,
      teamId: TEAM,
      jobId: JOB,
      attempt: 1,
      state: "ACKNOWLEDGED",
      leaseUntil: 0,
      stackId,
      fingerprint: deploymentIdentity(input).fingerprint,
    },
    stack: {
      StackId: stackId,
      StackName: stackName,
      StackStatus: "CREATE_COMPLETE",
      Tags: deploymentOwnershipTags(input),
      Outputs: [
        { OutputKey: "ParticipantViewerRoleArn", OutputValue: VIEWER_ARN },
        { OutputKey: "ParameterName", OutputValue: `/${stackName}/hello` },
        { OutputKey: "ExpectedFlag", OutputValue: "synthetic-private-flag" },
      ],
    },
    resource: {
      StackResourceDetail: {
        StackId: stackId,
        LogicalResourceId: "ParticipantViewerRole",
        PhysicalResourceId: VIEWER,
        ResourceType: "AWS::IAM::Role",
        ResourceStatus: "CREATE_COMPLETE",
      },
    },
    viewerResponse: credentials(),
    accepting: true,
    registered: true,
  };
  const work = {
    getJob: vi.fn<Work["getJob"]>(async () => structuredClone(state.job)),
    getTarget: vi.fn<Work["getTarget"]>(async () => structuredClone(state.target)),
    getConnection: vi.fn<Work["getConnection"]>(async () => structuredClone(state.connection)),
    getCreation: vi.fn<Work["getCreation"]>(async () => structuredClone(state.creation)),
    acceptingNewDeployments: vi.fn<Work["acceptingNewDeployments"]>(async () => state.accepting),
    assertParticipantAccessCurrent: vi.fn<Work["assertParticipantAccessCurrent"]>(async (scope) => {
      // One synchronous snapshot stands in for the real storage ConditionCheck transaction.
      const currentTeam = repository.teams.get(`${scope.team.eventId}/${scope.team.teamId}`);
      const currentEvent = repository.events.get(scope.event.eventId);
      const permitted = [
        state.accepting,
        state.registered,
        currentTeam?.accessRevoked === false,
        (currentTeam?.expiresAt ?? 0) > scope.now / 1000,
        (currentEvent?.expiresAt ?? 0) > scope.now / 1000,
        currentEvent !== undefined && scoringBlock(currentEvent, scope.now) === undefined,
        state.job?.status === "COMPLETE",
        state.job?.teardownStatus === undefined,
        Boolean(state.job?.completionDigest),
        (state.job?.expiresAt ?? 0) > scope.now / 1000,
      ];
      if (permitted.includes(false)) throw new Error("Atomic participant authorization changed");
      sameGuardValue(currentTeam, scope.team);
      sameGuardValue(currentEvent, scope.event);
      sameGuardValue(state.job, scope.job);
      sameGuardValue(state.connection, scope.job.connection);
      sameGuardValue(
        { jobId: state.target?.jobId, attempt: state.target?.attempt },
        { jobId: scope.job.jobId, attempt: scope.job.attempt },
      );
      sameGuardValue(
        {
          state: state.creation?.state,
          stackId: state.creation?.stackId,
          fingerprint: state.creation?.fingerprint,
        },
        { state: "ACKNOWLEDGED", stackId: scope.job.stackId, fingerprint: scope.fingerprint },
      );
    }),
  };
  const remote = vi.fn<(stage: RemoteStage) => Promise<void>>(async () => undefined);
  const resolveArtifacts = vi.fn<CloudParticipantAccess["resolveArtifacts"]>(async () => {
    await remote("artifacts");
    return artifacts;
  });
  const authorizeJob = vi.fn<CloudParticipantAccess["authorizeJob"]>(async () => {
    if (!state.registered) throw new Error("Registry authorization removed");
  });
  const getParameter = vi.fn(async () => ({
    Parameter: {
      ARN: connection.externalIdParameter,
      Type: "SecureString",
      Value: DEPLOYMENT_SECRET,
    },
  }));
  const assumeDeployment = vi.fn<CloudRunnerDependencies["sts"]["assumeRole"]>(async () => ({
    Credentials: {
      AccessKeyId: "ASIASYNTHETICDEPLOY01",
      SecretAccessKey: "SyntheticOnlyDeploymentSecret0123456789",
      SessionToken: "SyntheticOnlyDeploymentSession0123456789",
      Expiration: new Date(NOW + 900_000),
    },
  }));
  const describeStacks = vi.fn<CloudFormationTransport["describeStacks"]>(async () => {
    await remote("stack");
    return { Stacks: [structuredClone(state.stack)] };
  });
  const describeStackResource = vi.fn<
    NonNullable<CloudFormationTransport["describeStackResource"]>
  >(async () => structuredClone(state.resource));
  const createStack = vi.fn<CloudFormationTransport["createStack"]>();
  const deleteStack = vi.fn<CloudFormationTransport["deleteStack"]>();
  const cloudFormation = vi.fn<CloudRunnerDependencies["cloudFormation"]>(() => ({
    describeStacks,
    describeStackResource,
    createStack,
    deleteStack,
  }));
  const viewerSend = vi.fn<CloudParticipantAccess["sts"]["send"]>(async () => {
    await remote("viewer");
    return state.viewerResponse;
  });
  const access: CloudParticipantAccess = {
    work,
    resolveArtifacts,
    authorizeJob,
    runner: {
      ssm: () => ({ getParameter }),
      sts: { assumeRole: assumeDeployment },
      cloudFormation,
      now: () => state.now,
    },
    sts: { send: viewerSend },
    controlPlaneAccount: CONTROL_ACCOUNT,
  };
  const app = createCloudApp({
    repository,
    organizerAuth: { issuer: "https://issuer.example.test", audience: "test-client" },
    allowedOrigins: [],
    now: () => state.now,
    ...(enabled ? { participantAccess: access } : {}),
  });
  const request = (path = CLI_PATH, key = KEY) =>
    app.request(path, {
      headers: { Authorization: `Bearer ${key}` },
    });
  return {
    repository,
    event,
    team,
    job,
    connection,
    artifacts,
    state,
    work,
    remote,
    resolveArtifacts,
    authorizeJob,
    getParameter,
    assumeDeployment,
    describeStacks,
    describeStackResource,
    cloudFormation,
    createStack,
    deleteStack,
    viewerSend,
    app,
    request,
  };
}
type Fixture = ReturnType<typeof fixture>;
function updateEvent(f: Fixture, patch: Partial<EventRecord>) {
  f.repository.events.set(EVENT, { ...f.event, ...patch });
}
function updateTeam(f: Fixture, patch: Partial<TeamRecord>) {
  f.repository.teams.set(`${EVENT}/${TEAM}`, { ...f.team, ...patch });
}
function noIssuance(f: Fixture) {
  expect(f.viewerSend).not.toHaveBeenCalled();
  expect(f.createStack).not.toHaveBeenCalled();
  expect(f.deleteStack).not.toHaveBeenCalled();
}
async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error });
}
function barrier() {
  let release: () => void = () => {
    throw new Error("Barrier not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cloud participant CLI HTTP and existing frontend contract", () => {
  it("issues only the owned team's regional parameter permission when the deployment differs from the host region", async () => {
    const f = fixture(true, "ap-northeast-1");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      credentials: { region: "ap-northeast-1", awsAccountId: ACCOUNT },
    });
    expect(f.cloudFormation).toHaveBeenCalledWith(
      expect.objectContaining({ region: "ap-northeast-1", accountId: ACCOUNT }),
    );
    expect(f.getParameter).toHaveBeenCalledWith({
      Name: f.connection.externalIdParameter,
      WithDecryption: true,
    });
    expect(f.connection.externalIdParameter).toContain(":ssm:us-east-1:");
    const command = f.viewerSend.mock.calls[0]?.[0];
    expect(command?.input).toMatchObject({ ExternalId: JOB, DurationSeconds: 900 });
    const policy = JSON.parse(command?.input.Policy ?? "{}");
    const parameterArn = `arn:aws:ssm:ap-northeast-1:${ACCOUNT}:parameter/${f.job.stackName}/hello`;
    expect(policy.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Resource: parameterArn,
      },
      { Effect: "Deny", NotAction: ["ssm:GetParameter", "ssm:GetParameters"], Resource: "*" },
      {
        Effect: "Deny",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        NotResource: parameterArn,
      },
      {
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: {
          DateGreaterThanEquals: { "aws:CurrentTime": new Date(NOW + 900_000).toISOString() },
        },
      },
    ]);
    expect(f.createStack).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
  });
  it("returns only CLI credentials with no-store and uses distinct deployment and operator viewer transports", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        sessionToken: SESSION_TOKEN,
        expiration: new Date(NOW + 900_000).toISOString(),
        region: "us-east-1",
        awsAccountId: ACCOUNT,
      },
    });
    expect(f.assumeDeployment).toHaveBeenCalledExactlyOnceWith({
      RoleArn: f.connection.roleArn,
      RoleSessionName: `tc-${f.state.creation?.fingerprint?.slice(0, 48)}`,
      ExternalId: DEPLOYMENT_SECRET,
      DurationSeconds: 900,
    });
    expect(f.describeStacks).toHaveBeenCalledExactlyOnceWith({ StackName: f.job.stackId });
    expect(f.describeStackResource).toHaveBeenCalledExactlyOnceWith({
      StackName: f.job.stackId,
      LogicalResourceId: "ParticipantViewerRole",
    });
    expect(f.cloudFormation.mock.calls[0]?.[0].credentials.accessKeyId).toBe(
      "ASIASYNTHETICDEPLOY01",
    );
    expect(f.viewerSend).toHaveBeenCalledTimes(1);
    expect(f.work.assertParticipantAccessCurrent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        team: f.team,
        event: f.event,
        job: f.job,
        fingerprint: f.state.creation?.fingerprint,
        now: NOW,
      }),
    );
    expect(f.work.assertParticipantAccessCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.viewerSend.mock.invocationCallOrder[0] ?? 0,
    );
    const [command, options] = f.viewerSend.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    expect(command?.input).toMatchObject({
      RoleArn: VIEWER_ARN,
      RoleSessionName: `tc-view-${JOB}`,
      ExternalId: JOB,
      DurationSeconds: 900,
    });
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(f.createStack).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
  });

  it.each(["team", "job", "event", "STS"])(
    "caps returned expiry at the earliest %s boundary",
    async (boundary) => {
      const f = fixture();
      const deadline = NOW + 120_000;
      if (boundary === "team") updateTeam(f, { expiresAt: deadline / 1000 });
      if (boundary === "job") f.state.job = { ...f.job, expiresAt: deadline / 1000 };
      if (boundary === "event") updateEvent(f, { expiresAt: deadline / 1000 });
      if (boundary === "STS") {
        const returned = f.state.viewerResponse.Credentials;
        if (!returned) throw new Error("Missing fixture credentials");
        f.state.viewerResponse = {
          ...f.state.viewerResponse,
          Credentials: { ...returned, Expiration: new Date(deadline) },
        };
      }
      const response = await f.request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        credentials: { expiration: new Date(deadline).toISOString() },
      });
      expect(f.viewerSend.mock.calls[0]?.[0].input.DurationSeconds).toBe(900);
    },
  );

  it("the real portal getCliCredentials consumes the HTTP shape and forwards the current bearer and signal", async () => {
    const f = fixture();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.origin).toBe("https://offline.example.test");
      return f.app.request(`${url.pathname}${url.search}`, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    // Variable import keeps this frontend module under its own bundler-resolution typecheck.
    const client: {
      getCliCredentials(
        base: string,
        key: string,
        job: string,
        signal?: AbortSignal,
      ): Promise<CliCredentialsView>;
    } = await import(CLIENT_MODULE);
    const signal = new AbortController().signal;
    expect(
      await client.getCliCredentials("https://offline.example.test", KEY, JOB, signal),
    ).toEqual({
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      sessionToken: SESSION_TOKEN,
      expiration: new Date(NOW + 900_000).toISOString(),
      region: "us-east-1",
      awsAccountId: ACCOUNT,
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${KEY}` },
      cache: "no-store",
      signal,
    });
    f.viewerSend.mockRejectedValueOnce(new Error(`${SECRET_KEY} ${SESSION_TOKEN}`));
    await expect(
      client.getCliCredentials("https://offline.example.test", KEY, JOB),
    ).rejects.toMatchObject({
      name: "PortalAssumeRoleError",
      stage: "participant_viewer",
      reason: "Role access denied or temporary credentials unavailable.",
    });
  });

  it("advertises only CLI access on completed hello-world deployments when issuance is configured", async () => {
    const f = fixture();
    f.repository.deployments = [
      f.job,
      { ...f.job, jobId: OTHER, status: "IN_PROGRESS" },
      { ...f.job, jobId: `${OTHER.slice(0, -1)}4`, problemId: "other-problem" },
      { ...f.job, jobId: `${OTHER.slice(0, -1)}5`, teardownStatus: "PENDING" },
    ];
    const response = await f.request("/portal/me");
    expect(await response.json()).toMatchObject({
      problems: [
        { accessCapabilities: ["cli-credentials"] },
        { accessCapabilities: [] },
        { accessCapabilities: [] },
        { accessCapabilities: [] },
      ],
    });
    const disabled = fixture(false);
    expect(await (await disabled.request("/portal/me")).json()).toMatchObject({
      problems: [{ accessCapabilities: [] }],
    });
    expect((await disabled.request()).status).toBe(404);
    noIssuance(f);
  });

  it("refuses console federation without any remote AWS issuance", async () => {
    const f = fixture();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expectError(await f.request(CONSOLE_PATH), 409, "aws_console_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.resolveArtifacts).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.assumeDeployment).not.toHaveBeenCalled();
    noIssuance(f);
  });
});

describe("participant scope and immutable deployment guards", () => {
  it.each([
    "",
    "?jobId=",
    "?jobId=bad",
    `?jobId=${JOB}&jobId=${JOB}`,
    `?jobId=${JOB}&roleArn=${VIEWER_ARN}`,
    `?jobId=${JOB.toLowerCase()}`,
  ])("rejects invalid query %s before AWS access", async (query) => {
    const f = fixture();
    await expectError(await f.request(`/portal/me/cli-credentials${query}`), 400, "invalid_jobid");
    expect(f.work.getJob).not.toHaveBeenCalled();
    expect(f.resolveArtifacts).not.toHaveBeenCalled();
    noIssuance(f);
  });
  const guards: { name: string; mutate: (f: Fixture) => void; status: number; error: string }[] = [
    {
      name: "missing job",
      mutate: (f) => {
        f.state.job = undefined;
      },
      status: 403,
      error: "unauthorized",
    },
    {
      name: "another team",
      mutate: (f) => {
        f.state.job = { ...f.job, teamId: OTHER };
      },
      status: 403,
      error: "unauthorized",
    },
    {
      name: "another event",
      mutate: (f) => {
        f.state.job = { ...f.job, eventId: OTHER };
      },
      status: 403,
      error: "unauthorized",
    },
    {
      name: "old target job",
      mutate: (f) => {
        f.state.target = { ...f.job, jobId: OTHER };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "old attempt",
      mutate: (f) => {
        f.state.target = { ...f.job, attempt: 2 };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "non-complete job",
      mutate: (f) => {
        f.state.job = { ...f.job, status: "IN_PROGRESS" };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "teardown",
      mutate: (f) => {
        f.state.job = { ...f.job, teardownStatus: "PENDING" };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "unsupported problem",
      mutate: (f) => {
        f.state.job = { ...f.job, problemId: "other" };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "noncanonical problem directory",
      mutate: (f) => {
        f.state.job = { ...f.job, problemDir: "problems/aws/hello-world" };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "expired job",
      mutate: (f) => {
        f.state.job = { ...f.job, expiresAt: NOW / 1000 };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "revoked key",
      mutate: (f) => updateTeam(f, { accessRevoked: true }),
      status: 401,
      error: "unauthorized",
    },
    {
      name: "rotated key",
      mutate: (f) => updateTeam(f, { authVersion: 2, teamLoginKey: "B".repeat(43) }),
      status: 401,
      error: "unauthorized",
    },
    {
      name: "expired team",
      mutate: (f) => updateTeam(f, { expiresAt: NOW / 1000 }),
      status: 401,
      error: "unauthorized",
    },
    {
      name: "expired event",
      mutate: (f) => updateEvent(f, { expiresAt: NOW / 1000 }),
      status: 409,
      error: "scoring_ended",
    },
    {
      name: "closed event",
      mutate: (f) => updateEvent(f, { status: "TEARDOWN" }),
      status: 409,
      error: "scoring_ended",
    },
    {
      name: "ended schedule",
      mutate: (f) => updateEvent(f, { endsAt: AT }),
      status: 409,
      error: "scoring_ended",
    },
    {
      name: "future start",
      mutate: (f) => updateEvent(f, { startsAt: new Date(NOW + 1000).toISOString() }),
      status: 409,
      error: "scoring_not_started",
    },
    {
      name: "missing start",
      mutate: (f) => updateEvent(f, { startsAt: undefined }),
      status: 409,
      error: "scoring_not_started",
    },
    {
      name: "locked event",
      mutate: (f) => updateEvent(f, { scoringLocked: true }),
      status: 409,
      error: "scoring_locked",
    },
    {
      name: "removed event problem",
      mutate: (f) => updateEvent(f, { problems: [] }),
      status: 409,
      error: "not_ready",
    },
    {
      name: "removed connection",
      mutate: (f) => {
        f.state.connection = undefined;
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "rotated connection",
      mutate: (f) => {
        f.state.connection = { ...f.connection, version: 2 };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "revoked registry",
      mutate: (f) => {
        f.state.registered = false;
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "global teardown fence",
      mutate: (f) => {
        f.state.accepting = false;
      },
      status: 409,
      error: "installation_draining",
    },
    {
      name: "control account target",
      mutate: (f) => {
        f.state.job = { ...f.job, awsAccountId: CONTROL_ACCOUNT };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "wrong ExternalId",
      mutate: (f) => {
        f.state.job = { ...f.job, parameters: { ...f.job.parameters, ExternalId: OTHER } };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "wrong operator account",
      mutate: (f) => {
        f.state.job = {
          ...f.job,
          parameters: { ...f.job.parameters, TenkaCloudAccountId: ACCOUNT },
        };
      },
      status: 409,
      error: "not_ready",
    },
  ];
  it.each(guards)("rejects $name before remote access", async ({ mutate, status, error }) => {
    const f = fixture();
    mutate(f);
    await expectError(await f.request(), status, error);
    expect(f.resolveArtifacts).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    noIssuance(f);
  });
  it.each([undefined, "Basic synthetic", `Bearer ${"Z".repeat(43)}`])(
    "requires a current bearer: %s",
    async (authorization) => {
      const f = fixture();
      await expectError(
        await f.app.request(CLI_PATH, {
          headers: authorization ? { Authorization: authorization } : {},
        }),
        401,
        "unauthorized",
      );
      noIssuance(f);
    },
  );
  it.each(["missing", "requested", "stack", "fingerprint"])(
    "requires acknowledged exact creation: %s",
    async (kind) => {
      const f = fixture();
      const creation = f.state.creation;
      if (!creation) throw new Error("Missing fixture creation");
      if (kind === "missing") f.state.creation = undefined;
      if (kind === "requested") f.state.creation = { ...creation, state: "REQUESTED" };
      if (kind === "stack")
        f.state.creation = { ...creation, stackId: `${f.job.stackId}-replaced` };
      if (kind === "fingerprint") f.state.creation = { ...creation, fingerprint: "0".repeat(64) };
      await expectError(await f.request(), 409, "not_ready");
      expect(f.getParameter).not.toHaveBeenCalled();
      noIssuance(f);
    },
  );
});

describe("participant permission intersection", () => {
  it("sends an exact-parameter session policy denying broad listing, other resources, and all actions after expiry", async () => {
    const f = fixture();
    updateEvent(f, { endsAt: new Date(NOW + 120_000).toISOString() });
    const response = await f.request();
    expect(await response.json()).toMatchObject({
      credentials: { expiration: new Date(NOW + 120_000).toISOString() },
    });
    const policy = JSON.parse(f.viewerSend.mock.calls[0]?.[0].input.Policy ?? "null");
    const parameterArn = `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/${f.job.stackName}/hello`;
    expect(policy).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ssm:GetParameter", "ssm:GetParameters"],
          Resource: parameterArn,
        },
        { Effect: "Deny", NotAction: ["ssm:GetParameter", "ssm:GetParameters"], Resource: "*" },
        {
          Effect: "Deny",
          Action: ["ssm:GetParameter", "ssm:GetParameters"],
          NotResource: parameterArn,
        },
        {
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: {
            DateGreaterThanEquals: { "aws:CurrentTime": new Date(NOW + 120_000).toISOString() },
          },
        },
      ],
    });
    expect(JSON.stringify(policy)).not.toContain("DescribeParameters");
    expect(JSON.stringify(policy)).not.toContain("GetParametersByPath");
    expect(() => helloWorldSessionPolicy(`${parameterArn}/*`, AT)).toThrow();
    expect(() => helloWorldSessionPolicy(parameterArn, "invalid")).toThrow();
  });
});

describe("fresh authorization across remote awaits", () => {
  const changes: { name: string; mutate: (f: Fixture) => void; status: number; error: string }[] = [
    {
      name: "key revocation",
      mutate: (f) => updateTeam(f, { accessRevoked: true }),
      status: 401,
      error: "unauthorized",
    },
    {
      name: "key rotation",
      mutate: (f) => updateTeam(f, { authVersion: 2, teamLoginKey: "C".repeat(43) }),
      status: 401,
      error: "unauthorized",
    },
    {
      name: "authentication generation change",
      mutate: (f) => updateTeam(f, { authVersion: 2 }),
      status: 409,
      error: "not_ready",
    },
    {
      name: "event closure",
      mutate: (f) => updateEvent(f, { status: "TEARDOWN" }),
      status: 409,
      error: "scoring_ended",
    },
    {
      name: "new attempt",
      mutate: (f) => {
        f.state.target = { ...f.job, attempt: 2 };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "connection rotation",
      mutate: (f) => {
        f.state.connection = { ...f.connection, version: 2 };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "registry removal",
      mutate: (f) => {
        f.state.registered = false;
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "global fence",
      mutate: (f) => {
        f.state.accepting = false;
      },
      status: 409,
      error: "installation_draining",
    },
    {
      name: "scope fingerprint change",
      mutate: (f) => {
        f.state.job = { ...f.job, artifactDigest: "c".repeat(64) };
      },
      status: 409,
      error: "not_ready",
    },
    {
      name: "shorter access window",
      mutate: (f) => updateEvent(f, { endsAt: new Date(NOW + 30_000).toISOString() }),
      status: 409,
      error: "not_ready",
    },
    {
      name: "elapsed event end",
      mutate: (f) => {
        f.state.now = NOW + 3_600_000;
      },
      status: 409,
      error: "scoring_ended",
    },
  ];
  it.each(
    (["artifacts", "stack", "viewer"] as const).flatMap((stage) =>
      changes.map((change) => ({ stage, ...change })),
    ),
  )(
    "rejects $name while awaiting $stage without returning secrets",
    async ({ stage, mutate, status, error }) => {
      const f = fixture();
      const entered = barrier();
      const continueRemote = barrier();
      f.remote.mockImplementation(async (current) => {
        if (current === stage) {
          entered.release();
          await continueRemote.promise;
        }
      });
      const pending = f.request();
      await entered.promise;
      mutate(f);
      continueRemote.release();
      const response = await pending;
      const text = await response.clone().text();
      await expectError(response, status, error);
      expect(text).not.toContain(ACCESS_KEY);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(SESSION_TOKEN);
      expect(f.viewerSend).toHaveBeenCalledTimes(stage === "viewer" ? 1 : 0);
    },
  );
});

describe("atomic final guard across sequential authorization reads", () => {
  const mutations: { name: string; mutate: (f: Fixture) => void }[] = [
    { name: "revoked team key", mutate: (f) => updateTeam(f, { accessRevoked: true }) },
    {
      name: "rotated team key",
      mutate: (f) => updateTeam(f, { authVersion: 2, teamLoginKey: "D".repeat(43) }),
    },
    { name: "closed event", mutate: (f) => updateEvent(f, { status: "TEARDOWN" }) },
    { name: "locked event", mutate: (f) => updateEvent(f, { scoringLocked: true }) },
    {
      name: "job teardown",
      mutate: (f) => {
        f.state.job = { ...f.job, status: "DELETING", teardownStatus: "PENDING" };
      },
    },
    {
      name: "replaced target",
      mutate: (f) => {
        f.state.target = { ...f.job, jobId: OTHER };
      },
    },
    {
      name: "rotated connection",
      mutate: (f) => {
        f.state.connection = { ...f.connection, version: 2 };
      },
    },
    {
      name: "global drain fence",
      mutate: (f) => {
        f.state.accepting = false;
      },
    },
    {
      name: "registry revocation",
      mutate: (f) => {
        f.state.registered = false;
      },
    },
    {
      name: "replaced creation",
      mutate: (f) => {
        const creation = f.state.creation;
        if (!creation) throw new Error("Missing fixture creation");
        f.state.creation = { ...creation, stackId: `${f.job.stackId}-new` };
      },
    },
  ];
  it.each(
    (["getConnection", "authorizeJob", "acceptingNewDeployments"] as const).flatMap((stage) =>
      mutations.map((mutation) => {
        // Later sequential guards catch these cases before the atomic checkpoint.
        const earlyFence =
          mutation.name === "global drain fence" && stage !== "acceptingNewDeployments";
        const earlyRegistry = mutation.name === "registry revocation" && stage === "getConnection";
        return {
          stage,
          ...mutation,
          atomicCalls: earlyFence || earlyRegistry ? 0 : 1,
          error: earlyFence ? "installation_draining" : "not_ready",
        };
      }),
    ),
  )(
    "rejects $name committed during final $stage read",
    async ({ stage, mutate, atomicCalls, error }) => {
      const f = fixture();
      const entered = barrier();
      const resume = barrier();
      const originalConnection = f.work.getConnection.getMockImplementation();
      const originalAuthorization = f.authorizeJob.getMockImplementation();
      const originalIntake = f.work.acceptingNewDeployments.getMockImplementation();
      if (!originalConnection || !originalAuthorization || !originalIntake)
        throw new Error("Missing fixture read");
      const pauseFinalRead = async () => {
        if (f.viewerSend.mock.calls.length === 1) {
          entered.release();
          await resume.promise;
        }
      };
      if (stage === "getConnection")
        f.work.getConnection.mockImplementation(async (...args) => {
          const observed = await originalConnection(...args);
          await pauseFinalRead();
          return observed;
        });
      if (stage === "authorizeJob")
        f.authorizeJob.mockImplementation(async (...args) => {
          await originalAuthorization(...args);
          await pauseFinalRead();
        });
      if (stage === "acceptingNewDeployments")
        f.work.acceptingNewDeployments.mockImplementation(async () => {
          const observed = await originalIntake();
          await pauseFinalRead();
          return observed;
        });
      const pending = f.request();
      await entered.promise;
      mutate(f);
      resume.release();
      const response = await pending;
      const body = await response.clone().text();
      expect(response.status).toBe(409);
      expect(body).not.toContain(ACCESS_KEY);
      expect(body).not.toContain(SECRET_KEY);
      expect(body).not.toContain(SESSION_TOKEN);
      expect(f.viewerSend).toHaveBeenCalledTimes(1);
      expect(f.work.assertParticipantAccessCurrent).toHaveBeenCalledTimes(atomicCalls);
      await expectError(response, 409, error);
    },
  );

  it("rejects a DELETING job returned by final target lookup with unchanged job ID and attempt", async () => {
    const f = fixture();
    f.work.getTarget.mockImplementation(async () => {
      if (f.viewerSend.mock.calls.length === 1) {
        f.state.job = { ...f.job, status: "DELETING", teardownStatus: "PENDING" };
        f.state.target = f.state.job;
      }
      return structuredClone(f.state.target);
    });
    await expectError(await f.request(), 409, "not_ready");
    expect(f.work.assertParticipantAccessCurrent).toHaveBeenCalledTimes(1);
    expect(f.viewerSend).toHaveBeenCalledTimes(1);
  });

  it("withholds valid STS credentials if the final atomic guard fails", async () => {
    const f = fixture();
    f.work.assertParticipantAccessCurrent.mockRejectedValue(
      new Error(`${SECRET_KEY} ${SESSION_TOKEN}`),
    );
    await expectError(await f.request(), 409, "not_ready");
    expect(f.viewerSend).toHaveBeenCalledTimes(1);
    expect(f.work.assertParticipantAccessCurrent).toHaveBeenCalledTimes(1);
  });
});

describe("STS response validation and secret-safe failures", () => {
  const badCredentials: {
    name: string;
    patch: Partial<NonNullable<AssumeRoleCommandOutput["Credentials"]>>;
  }[] = [
    { name: "empty access key", patch: { AccessKeyId: "" } },
    { name: "malformed access key", patch: { AccessKeyId: "not a valid key" } },
    { name: "overlong access key", patch: { AccessKeyId: "A".repeat(129) } },
    { name: "empty secret", patch: { SecretAccessKey: "" } },
    { name: "malformed secret", patch: { SecretAccessKey: `${SECRET_KEY}\n` } },
    { name: "overlong secret", patch: { SecretAccessKey: "A".repeat(257) } },
    { name: "missing token", patch: { SessionToken: undefined } },
    { name: "malformed token", patch: { SessionToken: `${SESSION_TOKEN}\n` } },
    { name: "overlong token", patch: { SessionToken: "A".repeat(16385) } },
    { name: "expired credentials", patch: { Expiration: new Date(NOW) } },
    { name: "invalid expiration", patch: { Expiration: new Date(Number.NaN) } },
    { name: "overlong lifetime", patch: { Expiration: new Date(NOW + 906_000) } },
  ];
  it.each(badCredentials)("rejects $name without leaking returned material", async ({ patch }) => {
    const f = fixture();
    const valid = f.state.viewerResponse.Credentials;
    if (!valid) throw new Error("Missing fixture credentials");
    f.state.viewerResponse = { ...f.state.viewerResponse, Credentials: { ...valid, ...patch } };
    const response = await f.request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "assume_role_failed",
      stage: "participant_viewer",
      reason: "Role access denied or temporary credentials unavailable.",
    });
  });
  it.each([
    undefined,
    `arn:aws:sts::${CONTROL_ACCOUNT}:assumed-role/${VIEWER}/tc-view-${JOB}`,
    `arn:aws:sts::${ACCOUNT}:assumed-role/OtherRole/tc-view-${JOB}`,
    `arn:aws:sts::${ACCOUNT}:assumed-role/${VIEWER}/tc-view-${OTHER}`,
  ])("rejects absent or mismatched returned assumed-role identity: %s", async (arn) => {
    const f = fixture();
    f.state.viewerResponse = {
      ...f.state.viewerResponse,
      AssumedRoleUser: arn ? { Arn: arn, AssumedRoleId: "synthetic-role" } : undefined,
    };
    await expectError(await f.request(), 500, "assume_role_failed");
  });
  it.each(["competitor", "participant_viewer"])(
    "sanitizes %s SDK failures and never logs secrets",
    async (stage) => {
      const f = fixture();
      const spies = [
        vi.spyOn(console, "error"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "info"),
        vi.spyOn(console, "log"),
      ];
      for (const spy of spies) spy.mockImplementation(() => undefined);
      const error = new Error(`${KEY} ${DEPLOYMENT_SECRET} ${SECRET_KEY} ${SESSION_TOKEN}`);
      if (stage === "competitor") f.assumeDeployment.mockRejectedValue(error);
      else f.viewerSend.mockRejectedValue(error);
      const response = await f.request();
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "assume_role_failed",
        stage,
        reason: "Role access denied or temporary credentials unavailable.",
      });
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const secret of [KEY, DEPLOYMENT_SECRET, SECRET_KEY, SESSION_TOKEN])
        expect(logged).not.toContain(secret);
    },
  );
});
