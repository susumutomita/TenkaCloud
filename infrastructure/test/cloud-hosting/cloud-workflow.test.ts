import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { App, ArnFormat, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CloudApplicationStack } from "../../lib/cloud-hosting/application-stack.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import { CloudDeploymentPipeline } from "../../lib/cloud-hosting/deployment-pipeline.js";
import { createCloudDataCache } from "../../lib/problem-deploy/control-data/cloud-data.js";
import {
  type CreationReservation,
  contentDigest,
  DeploymentConflict,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
  type TeardownRecord,
} from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import {
  createAwsDispatcherDependencies,
  createAwsRecoveryDependencies,
  type DispatchDependencies,
  dispatchExecutionName,
  dispatchPending,
  type RecoveryDependencies,
  recoverTerminalExecution,
} from "../../lib/problem-deploy/handlers/cloud-runner/dispatcher.js";
import {
  type CloudFormationTransport,
  deploymentIdentity,
  deploymentOwnershipTags,
  parseDeploymentInput,
} from "../../lib/problem-deploy/handlers/cloud-runner/index.js";
import { createProductionWorkflowHandlers } from "../../lib/problem-deploy/handlers/cloud-runner/lambda.js";
import {
  createWorkflowHandlers,
  serializeDispatchIdentity,
  type WorkflowDependencies,
  type WorkflowRepository,
  type WorkflowState,
} from "../../lib/problem-deploy/handlers/cloud-runner/workflow.js";

const NOW = Date.parse("2026-10-01T09:00:00Z");
const EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const TEAM = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const MACHINE = "arn:aws:states:us-east-1:123456789012:stateMachine:CloudWorkflow";
const IDENTITY = { eventId: EVENT, teamId: TEAM, jobId: JOB, attempt: 1 };
const OWNER = `${MACHINE.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(IDENTITY)}`;
const PRIVATE_FLAG = "synthetic-private-flag-value";
const INITIAL: WorkflowState = { identity: IDENTITY, owner: OWNER, phase: "pending", pollCount: 0 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const data: {
    job: DeploymentJob;
    historical?: DeploymentJob;
    creation?: CreationReservation;
    teardown?: TeardownRecord;
    now: number;
    eventClosed: boolean;
  } = {
    now: NOW,
    eventClosed: false,
    job: {
      ...IDENTITY,
      problemId: "hello-world",
      region: "us-east-1",
      awsAccountId: "111111111111",
      status: "PENDING",
      expiresAt: NOW / 1000 + 86400,
      score: 0,
      revision: 0,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      stackName: deploymentStackName(EVENT, TEAM, "hello-world"),
      problemDir: "problems/aws/hello-world",
      artifactDigest: "a".repeat(64),
      catalogKey: `catalogs/${"b".repeat(64)}.json`,
      parameters: {
        NamePrefix: deploymentStackName(EVENT, TEAM, "hello-world"),
        FlagSeed: "synthetic-private-seed",
      },
      connection: {
        eventId: EVENT,
        teamId: TEAM,
        accountId: "111111111111",
        region: "us-east-1",
        roleArn: "arn:aws:iam::111111111111:role/TenkaCloudDeploy",
        externalIdParameter: "arn:aws:ssm:us-east-1:123456789012:parameter/cloud/team",
        version: 1,
        verifiedAt: new Date(NOW).toISOString(),
      },
      scoring: { kind: "flag", points: 100, wrongPenalty: 0, flagOutputKey: "ExpectedFlag" },
    },
  };
  data.creation = { ...IDENTITY, state: "NOT_STARTED", leaseUntil: 0 };
  const getCreation = vi.fn<WorkflowRepository["getCreation"]>(async () =>
    structuredClone(data.creation),
  );
  const reserveCreation = vi.fn<WorkflowRepository["reserveCreation"]>(
    async (identity, owner, now) => {
      if (data.eventClosed) throw new Error("event closed");
      data.creation = { ...identity, state: "REQUESTED", owner, leaseUntil: now + 120_000 };
    },
  );
  const recordCreation = vi.fn<WorkflowRepository["recordCreation"]>(
    async (_identity, owner, reference) => {
      if (!data.creation || data.creation.owner !== owner)
        throw new Error("creation owner changed");
      data.creation = { ...data.creation, state: "ACKNOWLEDGED", ...reference };
    },
  );
  const getTeardown = vi.fn<WorkflowRepository["getTeardown"]>(async (identity) => {
    if (
      data.teardown &&
      (identity.generation !== data.teardown.generation ||
        identity.attempt !== data.teardown.attempt)
    )
      throw new Error("teardown generation changed");
    return structuredClone(data.teardown);
  });
  const beginTeardown = vi.fn<WorkflowRepository["beginTeardown"]>(async (_identity, owner) => {
    if (data.teardown?.status !== "PENDING") throw new Error("teardown not pending");
    data.teardown = { ...data.teardown, owner, status: "IN_PROGRESS" };
    return "started";
  });
  const prepareDeletion = vi.fn<WorkflowRepository["prepareDeletion"]>(
    async (identity, _owner, now) => {
      const historical = identity.attempt !== data.job.attempt;
      if (
        (!historical && data.job.status === "IN_PROGRESS") ||
        (data.creation?.leaseUntil ?? 0) > now
      )
        return false;
      if (!historical) data.job = { ...data.job, status: "DELETING" };
      return true;
    },
  );
  const recordTeardownReference = vi.fn<WorkflowRepository["recordTeardownReference"]>(
    async (_identity, owner, reference) => {
      if (!data.teardown || data.teardown.owner !== owner)
        throw new Error("teardown owner changed");
      data.teardown = { ...data.teardown, ...reference };
    },
  );
  const finishTeardown = vi.fn<WorkflowRepository["finishTeardown"]>(
    async (identity, owner, result) => {
      if (
        !data.teardown ||
        data.teardown.generation !== identity.generation ||
        data.teardown.owner !== owner
      )
        throw new Error("teardown changed");
      data.teardown = { ...data.teardown, ...result };
      if (result.status === "DELETED" && identity.attempt === data.job.attempt)
        data.job = { ...data.job, status: "DELETED" };
      return "updated";
    },
  );
  const getJob = vi.fn<WorkflowRepository["getJob"]>(async () => structuredClone(data.job));
  const getDeletionJob = vi.fn<WorkflowRepository["getDeletionJob"]>(async (identity) => {
    const historical = identity.attempt !== data.job.attempt;
    const job = historical ? data.historical : data.job;
    if (
      !job ||
      job.jobId !== identity.jobId ||
      job.eventId !== identity.eventId ||
      job.teamId !== identity.teamId ||
      job.attempt !== identity.attempt
    )
      throw new DeploymentConflict("deployment_scope_or_attempt_changed");
    return { job: structuredClone(job), historical };
  });
  const getConnection = vi.fn<WorkflowRepository["getConnection"]>(async () =>
    structuredClone(data.job.connection),
  );
  const begin = vi.fn<WorkflowRepository["begin"]>(async (identity, owner) => {
    expect(identity).toEqual(IDENTITY);
    if (data.job.status === "IN_PROGRESS" && data.job.owner === owner) return "replay";
    data.job = { ...data.job, owner, status: "IN_PROGRESS" };
    return "started";
  });
  const finish = vi.fn<WorkflowRepository["finish"]>(async (_identity, owner, completion) => {
    if (data.job.owner !== owner) throw new Error("owner changed");
    data.job = { ...data.job, ...completion };
    return "updated";
  });
  const artifacts = {
    templateBody: "Resources: {}",
    artifactDigest: data.job.artifactDigest,
    capabilities: [],
    publicOutputKeys: ["ChallengeUrl"],
  };
  const resolveArtifacts = vi.fn<WorkflowDependencies["resolveArtifacts"]>(async () => artifacts);
  const authorizeJob = vi.fn<WorkflowDependencies["authorizeJob"]>(async () => undefined);
  const input = parseDeploymentInput({
    version: 1,
    eventId: EVENT,
    teamId: TEAM,
    jobId: JOB,
    problemId: data.job.problemId,
    attemptId: "1",
    target: {
      accountId: data.job.awsAccountId,
      region: data.job.region,
      roleArn: data.job.connection.roleArn,
      externalIdParameterArn: data.job.connection.externalIdParameter,
    },
    templateBody: artifacts.templateBody,
    capabilities: [],
    parameters: Object.entries(data.job.parameters ?? {}).map(([key, value]) => ({ key, value })),
    allowedOutputKeys: ["ChallengeUrl", "ExpectedFlag"],
  });
  const identity = deploymentIdentity(input);
  const stackId = `arn:aws:cloudformation:us-east-1:111111111111:stack/${identity.stackName}/synthetic-stack`;
  const stack = {
    StackId: stackId,
    StackName: identity.stackName,
    StackStatus: "CREATE_IN_PROGRESS",
    Tags: deploymentOwnershipTags(input),
    Outputs: [
      { OutputKey: "ChallengeUrl", OutputValue: "https://challenge.example.test" },
      { OutputKey: "ExpectedFlag", OutputValue: PRIVATE_FLAG },
      { OutputKey: "OtherSecret", OutputValue: "never-public" },
    ],
  };
  const describeStacks = vi.fn<CloudFormationTransport["describeStacks"]>(async () => ({
    Stacks: [stack],
  }));
  const createStack = vi.fn<CloudFormationTransport["createStack"]>(async () => ({
    StackId: stackId,
  }));
  const deleteStack = vi.fn<CloudFormationTransport["deleteStack"]>(async () => ({}));
  const getParameter = vi.fn(async () => ({
    Parameter: {
      ARN: data.job.connection.externalIdParameter,
      Type: "SecureString",
      Value: "synthetic-external-id",
    },
  }));
  const assumeRole = vi.fn(async () => ({
    Credentials: {
      AccessKeyId: "synthetic",
      SecretAccessKey: "synthetic",
      SessionToken: "synthetic",
      Expiration: new Date(NOW + 900_000),
    },
  }));
  const deps: WorkflowDependencies = {
    repository: {
      getJob,
      getDeletionJob,
      getConnection,
      begin,
      finish,
      getCreation,
      reserveCreation,
      recordCreation,
      getTeardown,
      beginTeardown,
      prepareDeletion,
      recordTeardownReference,
      finishTeardown,
    },
    resolveArtifacts,
    authorizeJob,
    now: () => data.now,
    runner: {
      ssm: () => ({ getParameter }),
      sts: { assumeRole },
      cloudFormation: () => ({ describeStacks, createStack, deleteStack }),
      now: () => data.now,
    },
  };
  return {
    data,
    deps,
    handlers: createWorkflowHandlers(deps),
    stack,
    stackId,
    input,
    begin,
    finish,
    getJob,
    getDeletionJob,
    getConnection,
    getParameter,
    assumeRole,
    describeStacks,
    createStack,
    resolveArtifacts,
    authorizeJob,
    getCreation,
    reserveCreation,
    recordCreation,
    getTeardown,
    beginTeardown,
    prepareDeletion,
    recordTeardownReference,
    finishTeardown,
    deleteStack,
  };
}

describe("durable cloud workflow state and ownership fencing", () => {
  it("claims, submits, polls, privately hashes the flag and finishes without secrets in SFN state", async () => {
    const f = fixture();
    const states: WorkflowState[] = [];
    let state = await f.handlers.claim(INITIAL);
    states.push(state);
    f.describeStacks.mockRejectedValueOnce(
      Object.assign(
        new Error(`Stack with id ${deploymentIdentity(f.input).stackName} does not exist`),
        { name: "ValidationError" },
      ),
    );
    state = await f.handlers.create(state);
    states.push(state);
    state = await f.handlers.describe(state);
    states.push(state);
    expect(state.phase).toBe("pending");
    expect(state.pollCount).toBe(1);
    f.stack.StackStatus = "CREATE_COMPLETE";
    state = await f.handlers.describe(state);
    states.push(state);
    state = await f.handlers.finish(state);
    states.push(state);
    expect(state.phase).toBe("ready");
    expect(f.data.job.flagDigest).toBe(flagDigest(PRIVATE_FLAG));
    expect(f.data.job.publicOutputs).toEqual({ ChallengeUrl: "https://challenge.example.test" });
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(
      IDENTITY,
      OWNER,
      {
        status: "COMPLETE",
        stackId: f.stackId,
        flagDigest: flagDigest(PRIVATE_FLAG),
        publicOutputs: { ChallengeUrl: "https://challenge.example.test" },
      },
      new Date(NOW).toISOString(),
    );
    expect(JSON.stringify(states)).not.toMatch(
      /synthetic-private|ExpectedFlag|ChallengeUrl|Resources|parameters|external-id/,
    );
    await expect(f.handlers.finish(state)).resolves.toEqual(state);
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it.each(["attempt", "owner", "connection", "binding"])(
    "rejects stale %s before remote create or describe",
    async (changed) => {
      const f = fixture();
      const claimed = await f.handlers.claim(INITIAL);
      const state = {
        ...claimed,
        reference: { stackId: f.stackId, fingerprint: deploymentIdentity(f.input).fingerprint },
      };
      if (changed === "attempt") f.data.job = { ...f.data.job, attempt: 2 };
      if (changed === "owner") f.data.job = { ...f.data.job, owner: `${OWNER}-other` };
      if (changed === "connection")
        f.getConnection.mockResolvedValue({ ...f.data.job.connection, version: 2 });
      if (changed === "binding") f.authorizeJob.mockRejectedValue(new Error("removed binding"));
      await expect(f.handlers.create(state)).rejects.toMatchObject({ name: "CloudWorkflowError" });
      await expect(f.handlers.describe(state)).rejects.toMatchObject({
        name: "CloudWorkflowError",
      });
      expect(f.getParameter).not.toHaveBeenCalled();
      expect(f.createStack).not.toHaveBeenCalled();
    },
  );

  it("rechecks connection after artifact I/O and rejects catalog digest drift", async () => {
    const f = fixture();
    const state = await f.handlers.claim(INITIAL);
    f.resolveArtifacts.mockImplementation(async () => {
      f.getConnection.mockResolvedValue({ ...f.data.job.connection, version: 2 });
      return {
        templateBody: "Resources: {}",
        artifactDigest: f.data.job.artifactDigest,
        capabilities: [],
        publicOutputKeys: ["ChallengeUrl"],
      };
    });
    await expect(f.handlers.create(state)).rejects.toThrow("could not complete");
    expect(f.getParameter).not.toHaveBeenCalled();
    const mismatch = fixture();
    await mismatch.handlers.claim(INITIAL);
    mismatch.resolveArtifacts.mockResolvedValue({
      templateBody: "Resources: {}",
      artifactDigest: "c".repeat(64),
      capabilities: [],
      publicOutputKeys: [],
    });
    await expect(mismatch.handlers.create(INITIAL)).rejects.toThrow("could not complete");
  });

  it("handles failed stacks, absent flags and bounded exhaustion as durable failures", async () => {
    for (const situation of ["stack", "flag", "exhausted"]) {
      const f = fixture();
      let state = await f.handlers.claim(INITIAL);
      state = await f.handlers.create(state);
      if (situation === "exhausted") {
        await f.handlers.fail({ ...state, pollCount: 120, failureCode: "poll_limit_exceeded" });
      } else {
        f.stack.StackStatus = situation === "stack" ? "CREATE_FAILED" : "CREATE_COMPLETE";
        if (situation === "flag") f.stack.Outputs = [];
        state = await f.handlers.describe(state);
        await f.handlers.finish(state);
      }
      expect(f.data.job.status).toBe("FAILED");
      expect(f.data.job.flagDigest).toBeUndefined();
      expect(f.data.job.failureReason).toBe(
        { stack: "stack_failed", flag: "flag_output_missing", exhausted: "poll_limit_exceeded" }[
          situation
        ],
      );
    }
  });

  it("never forwards exception text, malformed state or private catalog outputs", async () => {
    const f = fixture();
    await f.handlers.claim(INITIAL);
    f.resolveArtifacts.mockRejectedValue(new Error(PRIVATE_FLAG));
    await expect(f.handlers.create(INITIAL)).rejects.toThrow(
      "Cloud deployment worker could not complete its operation",
    );
    await expect(
      f.handlers.claim({ ...INITIAL, parameters: { FlagSeed: PRIVATE_FLAG } }),
    ).rejects.toThrow("could not complete");
    await expect(f.handlers.describe({ ...INITIAL, pollCount: 120 })).rejects.toThrow(
      "could not complete",
    );
    const unsafe = fixture();
    await unsafe.handlers.claim(INITIAL);
    unsafe.resolveArtifacts.mockResolvedValue({
      templateBody: "Resources: {}",
      artifactDigest: unsafe.data.job.artifactDigest,
      capabilities: [],
      publicOutputKeys: ["ExpectedFlag"],
    });
    await expect(unsafe.handlers.create(INITIAL)).rejects.toThrow("could not complete");
    expect(unsafe.getParameter).not.toHaveBeenCalled();
  });

  it("replays completion after a lost database response without issuing AWS work again", async () => {
    const f = fixture();
    let state = await f.handlers.claim(INITIAL);
    state = await f.handlers.create(state);
    f.stack.StackStatus = "CREATE_COMPLETE";
    state = await f.handlers.describe(state);
    f.finish.mockImplementationOnce(async (_identity, _owner, completion) => {
      f.data.job = { ...f.data.job, ...completion };
      throw new Error("synthetic lost response");
    });
    await expect(f.handlers.finish(state)).rejects.toThrow("could not complete");
    const calls = f.describeStacks.mock.calls.length;
    expect((await f.handlers.finish(state)).phase).toBe("ready");
    expect(f.describeStacks).toHaveBeenCalledTimes(calls);
    expect(f.finish).toHaveBeenCalledTimes(1);
  });
});

describe("production Lambda factory with every SDK send intercepted", () => {
  it("loads content-addressed bindings and refuses a withdrawn binding before STS or CFN", async () => {
    const f = fixture();
    f.data.job = {
      ...f.data.job,
      status: "IN_PROGRESS",
      owner: OWNER,
      expiresAt: Date.now() / 1000 + 86400,
      connection: {
        ...f.data.job.connection,
        bindingId: "account-approved",
        reviewedProblemIds: ["hello-world"],
      },
    };
    const binding = {
      id: "account-approved",
      accountId: f.data.job.awsAccountId,
      region: f.data.job.region,
      roleArn: f.data.job.connection.roleArn,
      externalIdParameterArn: f.data.job.connection.externalIdParameter,
      reviewedProblemIds: ["hello-world"],
    };
    let raw = JSON.stringify([binding]);
    for (const [key, value] of Object.entries({
      AWS_REGION: "us-east-1",
      CONTROL_PLANE_ACCOUNT: "123456789012",
      EVENTS_TABLE_NAME: "synthetic-events",
      TEAMS_TABLE_NAME: "synthetic-teams",
      DEPLOYMENTS_TABLE_NAME: "synthetic-deployments",
      CLOUD_ARTIFACT_BUCKET: "synthetic-artifacts",
      CLOUD_RUNNER_BINDINGS_KEY: `bindings/${contentDigest(raw)}.json`,
    }))
      vi.stubEnv(key, value);
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({
      $metadata: {},
      ContentLength: Buffer.byteLength(raw),
      Body: { transformToString: async () => raw },
    }));
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) {
        expect(command.input.TransactItems?.length).toBeGreaterThan(0);
        return {};
      }
      if (!(command instanceof GetCommand)) throw new Error("Unexpected Dynamo command");
      if (String(command.input.Key?.SK).startsWith("CREATE#")) return { Item: f.data.creation };
      return {
        Item: command.input.TableName === "synthetic-events" ? f.data.job.connection : f.data.job,
      };
    });
    const sts = vi.spyOn(STSClient.prototype, "send").mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: "synthetic",
        SecretAccessKey: "synthetic",
        SessionToken: "synthetic",
        Expiration: new Date(Date.now() + 900_000),
      },
    }));
    vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
      Parameter: {
        ARN: f.data.job.connection.externalIdParameter,
        Type: "SecureString",
        Value: "synthetic-external-id",
      },
    }));
    const cfn = vi
      .spyOn(CloudFormationClient.prototype, "send")
      .mockImplementation(async () => ({ Stacks: [f.stack] }));
    const handlers = await createProductionWorkflowHandlers(
      f.resolveArtifacts,
      createCloudDataCache({ env: process.env, region: process.env.AWS_REGION }),
    );
    expect((await handlers.create(INITIAL)).phase).toBe("pending");
    const calls = sts.mock.calls.length;
    const cfnCalls = cfn.mock.calls.length;
    raw = JSON.stringify([{ ...binding, id: "withdrawn" }]);
    vi.stubEnv("CLOUD_RUNNER_BINDINGS_KEY", `bindings/${contentDigest(raw)}.json`);
    const withdrawn = await createProductionWorkflowHandlers(
      f.resolveArtifacts,
      createCloudDataCache({ env: process.env, region: process.env.AWS_REGION }),
    );
    await expect(withdrawn.create(INITIAL)).rejects.toThrow("could not complete");
    expect(sts).toHaveBeenCalledTimes(calls);
    expect(cfn).toHaveBeenCalledTimes(cfnCalls);
  });
});

describe("registry-backed production worker with intercepted SDKs", () => {
  it("checks the current registry before STS, rejects revoked/recreated/foreign records, and never falls back to legacy bindings", async () => {
    const f = fixture();
    const roleName = `TenkaCloud-${"a".repeat(24)}-deploy-Role`;
    const parameter = `arn:aws:ssm:us-east-1:123456789012:parameter/tenkacloud/cloud/${"a".repeat(24)}/external-id`;
    const original = {
      awsAccountId: f.data.job.awsAccountId,
      // Account/bootstrap verification is independent of this job's us-east-1 target.
      region: "ap-northeast-1",
      competitorRoleName: roleName,
      registrationId: JOB,
      revision: 2,
      verified: true,
      verifiedAt: new Date(NOW).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      createdBy: "synthetic-organizer",
    };
    let record: typeof original | undefined = original;
    f.data.job = {
      ...f.data.job,
      status: "IN_PROGRESS",
      owner: OWNER,
      expiresAt: Date.now() / 1000 + 86400,
      connection: {
        ...f.data.job.connection,
        bindingId: `account-${JOB.toLowerCase()}`,
        registrationId: JOB,
        roleArn: `arn:aws:iam::${original.awsAccountId}:role/${roleName}`,
        externalIdParameter: parameter,
        reviewedProblemIds: ["hello-world"],
      },
    };
    const raw = "[]";
    for (const [key, value] of Object.entries({
      AWS_REGION: "us-east-1",
      CONTROL_PLANE_ACCOUNT: "123456789012",
      EVENTS_TABLE_NAME: "events",
      TEAMS_TABLE_NAME: "teams",
      DEPLOYMENTS_TABLE_NAME: "deployments",
      CLOUD_ARTIFACT_BUCKET: "artifacts",
      CLOUD_RUNNER_BINDINGS_KEY: `bindings/${contentDigest(raw)}.json`,
      COMPETITOR_ROLE_NAME: roleName,
      COMPETITOR_EXTERNAL_ID_PARAMETER_ARN: parameter,
    }))
      vi.stubEnv(key, value);
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({
      ContentLength: raw.length,
      Body: { transformToString: async () => raw },
    }));
    const registryRow = () =>
      record
        ? { Item: { ...record, PK: "INSTALLATION#ACCOUNTS", SK: `ACCOUNT#${record.awsAccountId}` } }
        : {};
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) return {};
      if (!(command instanceof GetCommand)) throw new Error("Unexpected Dynamo command");
      if (command.input.Key?.PK === "INSTALLATION#ACCOUNTS") return registryRow();
      if (String(command.input.Key?.SK).startsWith("CREATE#")) return { Item: f.data.creation };
      return { Item: command.input.TableName === "events" ? f.data.job.connection : f.data.job };
    });
    const sts = vi.spyOn(STSClient.prototype, "send").mockImplementation(async () => ({
      Credentials: {
        AccessKeyId: "synthetic",
        SecretAccessKey: "synthetic",
        SessionToken: "synthetic",
        Expiration: new Date(Date.now() + 900000),
      },
    }));
    const ssm = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
      Parameter: { ARN: parameter, Type: "SecureString", Value: "synthetic-external-id" },
    }));
    const cfn = vi
      .spyOn(CloudFormationClient.prototype, "send")
      .mockImplementation(async (command) => {
        if (command.constructor.name === "CreateStackCommand") return { StackId: f.stackId };
        throw Object.assign(new Error(`Stack with id ${f.data.job.stackName} does not exist`), {
          name: "ValidationError",
        });
      });
    const handlers = await createProductionWorkflowHandlers(
      f.resolveArtifacts,
      createCloudDataCache({ env: process.env, region: process.env.AWS_REGION }),
    );
    expect((await handlers.create(INITIAL)).phase).toBe("pending");
    const before = [sts.mock.calls.length, ssm.mock.calls.length, cfn.mock.calls.length];
    for (const changed of [
      undefined,
      { ...original, verified: false },
      { ...original, registrationId: EVENT },
      { ...original, competitorRoleName: "Administrator" },
    ]) {
      record = changed;
      await expect(handlers.create(INITIAL)).rejects.toThrow("could not complete");
      expect([sts.mock.calls.length, ssm.mock.calls.length, cfn.mock.calls.length]).toEqual(before);
    }
    record = original;
    const safe = f.data.job;
    f.data.job = { ...safe, region: "eu-west-1" };
    await expect(handlers.create(INITIAL)).rejects.toThrow("could not complete");
    expect([sts.mock.calls.length, ssm.mock.calls.length, cfn.mock.calls.length]).toEqual(before);
    f.data.job = {
      ...safe,
      awsAccountId: "123456789012",
      connection: {
        ...safe.connection,
        accountId: "123456789012",
        roleArn: `arn:aws:iam::123456789012:role/${roleName}`,
      },
    };
    await expect(handlers.create(INITIAL)).rejects.toThrow("could not complete");
    expect([sts.mock.calls.length, ssm.mock.calls.length, cfn.mock.calls.length]).toEqual(before);
    f.data.job = safe;
    f.data.job = {
      ...f.data.job,
      connection: {
        ...f.data.job.connection,
        externalIdParameter: `${parameter}-foreign`,
      },
    };
    await expect(handlers.create(INITIAL)).rejects.toThrow("could not complete");
    expect([sts.mock.calls.length, ssm.mock.calls.length, cfn.mock.calls.length]).toEqual(before);
  });
});

function unusedDispatchRecovery() {
  return {
    getDeletionJob: vi.fn<DispatchDependencies["repository"]["getDeletionJob"]>(),
    getTeardown: vi.fn<DispatchDependencies["repository"]["getTeardown"]>(),
    finishTeardown: vi.fn<DispatchDependencies["repository"]["finishTeardown"]>(),
  };
}

describe("scheduled durable intent dispatcher", () => {
  it.each([
    ["create", "RUNNING"],
    ["create", "SUCCEEDED"],
    ["delete", "RUNNING"],
    ["delete", "SUCCEEDED"],
  ] as const)(
    "overlapping %s dispatches share one Standard execution when it is %s",
    async (operation, status) => {
      const identity = {
        ...IDENTITY,
        ...(operation === "delete" ? { operation, generation: 1 } : {}),
      };
      const intents = [{ ...identity, createdAt: new Date(NOW).toISOString() }];
      const executions = new Map<string, { input: string; executionArn: string }>();
      let active = 0;
      let peak = 0;
      const startExecution = vi.fn<DispatchDependencies["startExecution"]>(async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        const existing = executions.get(input.name);
        if (existing) {
          // AWS Standard returns the same ARN for a running name/input, but rejects a
          // closed execution even when it finished before an overlapping request arrived.
          if (existing.input !== input.input || status !== "RUNNING")
            throw Object.assign(new Error("already exists"), { name: "ExecutionAlreadyExists" });
          return { executionArn: existing.executionArn };
        }
        const executionArn = `${MACHINE.replace(":stateMachine:", ":execution:")}:${input.name}`;
        executions.set(input.name, { input: input.input, executionArn });
        return { executionArn };
      });
      const deps: DispatchDependencies = {
        repository: {
          ...unusedDispatchRecovery(),
          getDeletionJob: fixture().getDeletionJob,
          // Independent invocations read the same persisted intent before its worker claims it.
          listDispatch: async () => structuredClone(intents),
          acceptingNewDeployments: async () => operation === "create",
        },
        stateMachineArn: MACHINE,
        startExecution,
        describeExecution: vi.fn<DispatchDependencies["describeExecution"]>(),
      };
      const summaries = await Promise.all([dispatchPending(deps), dispatchPending(deps)]);
      expect(peak).toBe(2);
      expect(startExecution).toHaveBeenCalledTimes(2);
      expect(startExecution.mock.calls[0]).toEqual(startExecution.mock.calls[1]);
      expect(executions).toEqual(
        new Map([
          [
            dispatchExecutionName(identity),
            {
              input: serializeDispatchIdentity(identity),
              executionArn: `${MACHINE.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(identity)}`,
            },
          ],
        ]),
      );
      expect(summaries).toEqual([
        { pending: 1, started: 1, duplicate: 0, uncertain: 0 },
        {
          pending: 1,
          started: status === "RUNNING" ? 1 : 0,
          duplicate: status === "RUNNING" ? 0 : 1,
          uncertain: 0,
        },
      ]);
      expect(intents).toEqual([{ ...identity, createdAt: new Date(NOW).toISOString() }]);
      expect(deps.repository.getTeardown).not.toHaveBeenCalled();
      expect(deps.repository.finishTeardown).not.toHaveBeenCalled();
      expect(deps.describeExecution).not.toHaveBeenCalled();
    },
  );

  it("uses byte-identical Standard execution input/name and leaves uncertain/duplicate intents intact", async () => {
    const intents = Array.from({ length: 3 }, (_, i) => ({
      ...IDENTITY,
      attempt: i + 1,
      createdAt: new Date(NOW).toISOString(),
    }));
    const listDispatch = vi.fn(async () => intents);
    const startExecution = vi.fn<DispatchDependencies["startExecution"]>(async (input) => {
      if (input.name.endsWith("-2"))
        throw Object.assign(new Error("already exists"), { name: "ExecutionAlreadyExists" });
      if (input.name.endsWith("-3")) throw new Error("uncertain transport result");
      return { executionArn: `${MACHINE.replace(":stateMachine:", ":execution:")}:${input.name}` };
    });
    const deps = {
      repository: {
        ...unusedDispatchRecovery(),
        listDispatch,
        acceptingNewDeployments: async () => true,
      },
      stateMachineArn: MACHINE,
      startExecution,
      describeExecution: vi.fn<DispatchDependencies["describeExecution"]>(),
    };
    expect(await dispatchPending(deps)).toEqual({
      pending: 3,
      started: 1,
      duplicate: 1,
      uncertain: 1,
    });
    await dispatchPending(deps);
    expect(startExecution.mock.calls.slice(0, 3)).toEqual(startExecution.mock.calls.slice(3));
    expect(startExecution.mock.calls[0]?.[0].input).toBe(serializeDispatchIdentity(IDENTITY));
    expect(intents).toHaveLength(3);
    expect(deps.repository.getDeletionJob).not.toHaveBeenCalled();
    expect(deps.repository.getTeardown).not.toHaveBeenCalled();
    expect(deps.describeExecution).not.toHaveBeenCalled();
  });

  it("dispatches only cleanup while the installation is closed and rejects stale creation results", async () => {
    const identity = {
      ...IDENTITY,
      operation: "delete" as const,
      generation: 1,
      createdAt: new Date(NOW).toISOString(),
    };
    const listDispatch = vi.fn(async () => [identity]);
    const startExecution = vi.fn<DispatchDependencies["startExecution"]>(async (input) => ({
      executionArn: `${MACHINE.replace(":stateMachine:", ":execution:")}:${input.name}`,
    }));
    const deps = {
      repository: {
        ...unusedDispatchRecovery(),
        listDispatch,
        acceptingNewDeployments: async () => false,
      },
      stateMachineArn: MACHINE,
      startExecution,
      describeExecution: vi.fn<DispatchDependencies["describeExecution"]>(),
    };
    expect((await dispatchPending(deps)).started).toBe(1);
    expect(listDispatch).toHaveBeenCalledWith(100, { deletesOnly: true });
    expect(startExecution.mock.calls[0]?.[0].name).toContain("tc-delete-");
    const stale = {
      ...deps,
      repository: {
        ...deps.repository,
        listDispatch: async () => [{ ...IDENTITY, createdAt: new Date(NOW).toISOString() }],
      },
    };
    await expect(dispatchPending(stale)).rejects.toThrow("Creation dispatch is closed");
    expect(startExecution).toHaveBeenCalledTimes(1);
  });

  it("bounds a 500-intent batch to five concurrent starts and rejects invalid limits", async () => {
    let active = 0;
    let peak = 0;
    const listDispatch = vi.fn(async () =>
      Array.from({ length: 500 }, (_, i) => ({
        ...IDENTITY,
        attempt: i + 1,
        createdAt: new Date(NOW).toISOString(),
      })),
    );
    const startExecution: DispatchDependencies["startExecution"] = async ({ name }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { executionArn: `${MACHINE.replace(":stateMachine:", ":execution:")}:${name}` };
    };
    const deps = {
      repository: {
        ...unusedDispatchRecovery(),
        listDispatch,
        acceptingNewDeployments: async () => true,
      },
      stateMachineArn: MACHINE,
      startExecution,
      describeExecution: vi.fn<DispatchDependencies["describeExecution"]>(),
    };
    expect((await dispatchPending(deps, { limit: 500, concurrency: 5 })).started).toBe(500);
    expect(peak).toBe(5);
    expect(listDispatch).toHaveBeenCalledWith(500, { deletesOnly: false });
    await expect(dispatchPending(deps, { limit: 501 })).rejects.toThrow("bounds");
    await expect(dispatchPending(deps, { concurrency: 11 })).rejects.toThrow("bounds");
  });
});

describe("terminal Standard execution reconciliation", () => {
  const event = {
    source: "aws.states",
    "detail-type": "Step Functions Execution Status Change",
    detail: { stateMachineArn: MACHINE, executionArn: OWNER, status: "ABORTED" },
  };
  function recovery() {
    const f = fixture();
    const failPending = vi.fn<RecoveryDependencies["repository"]["failPending"]>(
      async (_identity, failureReason) => {
        f.data.job = { ...f.data.job, status: "FAILED", failureReason };
        return "updated";
      },
    );
    const describeExecution = vi.fn<RecoveryDependencies["describeExecution"]>(async () => ({
      stateMachineArn: MACHINE,
      executionArn: OWNER,
      status: "ABORTED",
      input: serializeDispatchIdentity(IDENTITY),
    }));
    const deps: RecoveryDependencies = {
      stateMachineArn: MACHINE,
      repository: {
        getJob: f.getJob,
        finish: f.finish,
        failPending,
        getTeardown: f.getTeardown,
        finishTeardown: f.finishTeardown,
      },
      describeExecution,
      now: () => NOW,
    };
    return { ...f, deps, failPending, describeExecution };
  }

  it.each(["FAILED", "TIMED_OUT", "ABORTED"])(
    "records a fenced durable failure after an owned %s execution",
    async (status) => {
      const f = recovery();
      await f.handlers.claim(INITIAL);
      f.describeExecution.mockResolvedValue({
        stateMachineArn: MACHINE,
        executionArn: OWNER,
        status,
        input: serializeDispatchIdentity(IDENTITY),
      });
      expect(await recoverTerminalExecution(event, f.deps)).toEqual({ outcome: "failed_owned" });
      expect(f.finish).toHaveBeenCalledExactlyOnceWith(
        IDENTITY,
        OWNER,
        { status: "FAILED", failureReason: `workflow_${status.toLowerCase()}` },
        new Date(NOW).toISOString(),
      );
      expect(f.failPending).not.toHaveBeenCalled();
      expect(await recoverTerminalExecution(event, f.deps)).toEqual({
        outcome: "already_terminal",
      });
      expect(f.finish).toHaveBeenCalledTimes(1);
    },
  );

  it("fails a pre-claim pending intent through the atomic repository method", async () => {
    const f = recovery();
    expect(await recoverTerminalExecution(event, f.deps)).toEqual({ outcome: "failed_pending" });
    expect(f.failPending).toHaveBeenCalledExactlyOnceWith(
      IDENTITY,
      "workflow_aborted",
      new Date(NOW).toISOString(),
    );
    expect(f.finish).not.toHaveBeenCalled();
  });

  it.each(["attempt", "owner", "completed"])("leaves %s jobs untouched", async (condition) => {
    const f = recovery();
    await f.handlers.claim(INITIAL);
    if (condition === "attempt") f.data.job = { ...f.data.job, attempt: 2 };
    if (condition === "owner") f.data.job = { ...f.data.job, owner: `${OWNER}-other` };
    if (condition === "completed") f.data.job = { ...f.data.job, status: "COMPLETE" };
    await recoverTerminalExecution(event, f.deps);
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.failPending).not.toHaveBeenCalled();
  });

  it("rejects unrelated machine, noncanonical input and execution-name mismatch before mutation", async () => {
    const f = recovery();
    await expect(
      recoverTerminalExecution(
        { ...event, detail: { ...event.detail, stateMachineArn: `${MACHINE}Other` } },
        f.deps,
      ),
    ).rejects.toThrow("target mismatch");
    expect(f.describeExecution).not.toHaveBeenCalled();
    for (const input of [
      serializeDispatchIdentity({ ...IDENTITY, attempt: 2 }),
      ` ${serializeDispatchIdentity(IDENTITY)}`,
      JSON.stringify({ identity: IDENTITY, secret: PRIVATE_FLAG }),
    ]) {
      f.describeExecution.mockResolvedValue({
        stateMachineArn: MACHINE,
        executionArn: OWNER,
        status: "FAILED",
        input,
      });
      await expect(recoverTerminalExecution(event, f.deps)).rejects.toThrow();
    }
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.failPending).not.toHaveBeenCalled();
  });

  it("uses authoritative execution status and ignores a stale terminal notification", async () => {
    const f = recovery();
    f.describeExecution.mockResolvedValue({
      stateMachineArn: MACHINE,
      executionArn: OWNER,
      status: "RUNNING",
      input: serializeDispatchIdentity(IDENTITY),
    });
    expect(await recoverTerminalExecution(event, f.deps)).toEqual({ outcome: "ignored" });
    expect(f.getJob).not.toHaveBeenCalled();
  });

  it("constructs real SFN commands with every send intercepted and no AWS network calls", async () => {
    for (const [key, value] of Object.entries({
      AWS_REGION: "us-east-1",
      CONTROL_PLANE_ACCOUNT: "123456789012",
      EVENTS_TABLE_NAME: "synthetic-events",
      TEAMS_TABLE_NAME: "synthetic-teams",
      DEPLOYMENTS_TABLE_NAME: "synthetic-deployments",
      DEPLOYMENT_STATE_MACHINE_ARN: MACHINE,
    }))
      vi.stubEnv(key, value);
    const send = vi
      .spyOn(SFNClient.prototype, "send")
      .mockImplementation(async () => ({ $metadata: {}, executionArn: OWNER }));
    const dispatch = await createAwsDispatcherDependencies();
    await dispatch.startExecution({
      stateMachineArn: MACHINE,
      name: dispatchExecutionName(IDENTITY),
      input: serializeDispatchIdentity(IDENTITY),
    });
    const recoveryDeps = await createAwsRecoveryDependencies();
    await recoveryDeps.describeExecution({ executionArn: OWNER });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(StartExecutionCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DescribeExecutionCommand);
    for (const client of send.mock.contexts) {
      if (!(client instanceof SFNClient)) throw new Error("SFN client was not intercepted");
      expect(await client.config.region()).toBe("us-east-1");
      expect(client.config.ignoreConfiguredEndpointUrls).toBe(true);
    }
  });
});

const synthDirectory = mkdtempSync(join(tmpdir(), "cloud-workflow-synth-"));
afterAll(() => rmSync(synthDirectory, { recursive: true, force: true }));
describe("optional deployment pipeline offline synthesis", () => {
  it("synthesizes bounded Standard workflow with scoped separate worker permissions and no execution data logs", () => {
    const app = new App({ outdir: synthDirectory });
    const stack = new Stack(app, "PipelineTest", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const table = (name: string) =>
      new Table(stack, name, {
        partitionKey: { name: "PK", type: AttributeType.STRING },
        sortKey: { name: "SK", type: AttributeType.STRING },
      });
    const binding = {
      id: "team-account",
      accountId: "111111111111",
      region: "us-east-1",
      roleArn: "arn:aws:iam::111111111111:role/TenkaCloudDeploy",
      externalIdParameterArn: "arn:aws:ssm:us-east-1:123456789012:parameter/cloud/team",
      reviewedProblemIds: ["hello-world"],
    };
    const props = {
      repositoryRoot: resolve(import.meta.dirname, "../../.."),
      controlData: {
        kind: "dynamodb" as const,
        events: table("Events"),
        teams: table("Teams"),
        deployments: table("Deployments"),
      },
      allowedRoleArns: [binding.roleArn],
      runnerBindings: [binding],
      externalIdParameterArns: [binding.externalIdParameterArn],
      catalogBucket: new Bucket(stack, "Catalog", {
        enforceSSL: true,
        versioned: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      }),
      catalogKey: `catalogs/${"a".repeat(64)}.json`,
      bindingsKey: `bindings/${"b".repeat(64)}.json`,
    };
    expect(
      () => new CloudDeploymentPipeline(stack, "Disabled", { ...props, allowedRoleArns: [] }),
    ).toThrow("allowlists");
    const pipeline = new CloudDeploymentPipeline(stack, "Pipeline", props);
    expect(pipeline.stateMachine).toBeDefined();
    app.synth();
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
      LoggingConfiguration: { IncludeExecutionData: false, Level: "ERROR" },
    });
    const machines = template.findResources("AWS::StepFunctions::StateMachine");
    const text = JSON.stringify(machines);
    expect(text).toContain("WaitForStack");
    expect(text).toContain('Seconds\\":30');
    expect(text).toContain("PollLimitExceeded");
    expect(text).toContain("PersistFailure");
    expect(text).not.toMatch(/FlagSeed|ExpectedFlag|TemplateBody|publicOutputs/);
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Action: string | string[];
          Effect: string;
          Resource: unknown;
          Condition?: Record<string, Record<string, string[]>>;
        }[],
    );
    const assumes = statements.filter(
      (statement) =>
        JSON.stringify(statement.Action).includes("sts:AssumeRole") && statement.Effect === "Allow",
    );
    expect(assumes).toHaveLength(3);
    expect(
      assumes.every(
        (statement) => JSON.stringify(statement.Resource) === JSON.stringify(binding.roleArn),
      ),
    ).toBe(true);
    const permissions = JSON.stringify(statements);
    expect(permissions).not.toMatch(
      /AdministratorAccess|cloudformation:|dynamodb:\*|ssm:\*|states:\*/,
    );
    const historyQueries = statements.filter(
      (statement) =>
        JSON.stringify(statement.Action).includes("dynamodb:Query") &&
        statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]?.includes(
          "DEPLOYMENT#*",
        ),
    );
    expect(historyQueries).toHaveLength(3);
    expect(
      historyQueries.every(
        (statement) =>
          JSON.stringify(statement.Resource) ===
          JSON.stringify(stack.resolve(props.controlData.deployments.tableArn)),
      ),
    ).toBe(true);
    const finishRole = JSON.stringify(stack.resolve(pipeline.workers.finish.role?.roleName));
    const finishPolicies = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) =>
        policy.Properties.Roles.some((role: unknown) => JSON.stringify(role) === finishRole),
      )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as typeof statements);
    expect(finishPolicies).toContainEqual(
      expect.objectContaining({
        Action: "dynamodb:DeleteItem",
        Resource: stack.resolve(props.controlData.deployments.tableArn),
        Condition: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["DISPATCH#PENDING"] },
        },
      }),
    );
    const dispatcherRole = JSON.stringify(stack.resolve(pipeline.dispatcher.role?.roleName));
    const dispatcherPolicies = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) =>
        policy.Properties.Roles.some((role: unknown) => JSON.stringify(role) === dispatcherRole),
      )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as typeof statements);
    expect(dispatcherPolicies).toContainEqual(
      expect.objectContaining({
        Action: "states:DescribeExecution",
        Resource: stack.resolve(
          stack.formatArn({
            service: "states",
            resource: "execution",
            resourceName: `${pipeline.stateMachine.stateMachineName}:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ),
      }),
    );
    expect(dispatcherPolicies).toContainEqual(
      expect.objectContaining({
        Action: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        Resource: stack.resolve(props.controlData.deployments.tableArn),
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DEPLOYMENT#*", "DISPATCH#PENDING"],
          },
        },
      }),
    );
    const objectReads = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes("s3:GetObject"),
    );
    const readResources = JSON.stringify(objectReads.map((statement) => statement.Resource));
    // Historical content-addressed catalogs stay readable after an application update; current
    // bindings remain exact and no other bucket prefix or entire-bucket wildcard is granted.
    expect(readResources).toContain("/catalogs/*");
    expect(readResources).toContain(`/bindings/${"b".repeat(64)}.json`);
    expect(readResources).not.toContain("/bindings/*");
    expect(readResources).not.toContain('"/*"');
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 minute)" });
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["aws.states"],
        "detail-type": ["Step Functions Execution Status Change"],
        detail: {
          status: ["FAILED", "TIMED_OUT", "ABORTED"],
          stateMachineArn: [{ Ref: Object.keys(machines)[0] }],
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Timeout: 120,
      ReservedConcurrentExecutions: Match.absent(),
    });
    for (const resource of Object.values(template.findResources("AWS::Lambda::Function")))
      expect(resource.Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    const all = JSON.stringify(template.toJSON());
    expect(all).not.toContain('"CLOUD_RUNNER_BINDINGS":');
    expect(all).toContain("CLOUD_RUNNER_BINDINGS_KEY");
  }, 90_000);

  it("wires the real application, pinned hello-world catalog and 25 S3 bindings without oversized Lambda environment", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const directory = join(synthDirectory, "application");
    const assets = join(synthDirectory, "site-assets");
    mkdirSync(assets);
    writeFileSync(
      join(assets, "index.html"),
      "<!doctype html><title>Synthetic frontend assets</title>",
    );
    const app = new App({ outdir: directory });
    const env = { account: "123456789012", region: "us-east-1" };
    const backend = new CloudDataStack(app, "ApplicationData", {
      env,
      participantAssets: assets,
      environment: "workflow-test",
    });
    const bindings = Array.from({ length: 25 }, (_, index) => ({
      id: `team-${index}`,
      accountId: "111111111111",
      region: "us-east-1",
      roleArn: `arn:aws:iam::111111111111:role/TenkaCloudTeam${index}`,
      externalIdParameterArn: `arn:aws:ssm:us-east-1:123456789012:parameter/cloud/team${index}`,
      reviewedProblemIds: ["hello-world"],
    }));
    expect(Buffer.byteLength(JSON.stringify(bindings))).toBeGreaterThan(4096);
    const application = new CloudApplicationStack(app, "CloudApplicationWithRunner", {
      env,
      repositoryRoot: root,
      consoleAssets: assets,
      environment: "workflow-test",
      backend,
      runnerBindings: bindings,
    });
    app.synth();
    const template = Template.fromStack(application);
    const routes = template.findResources("AWS::ApiGateway::Resource");
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
    for (const [path, verb, authorization] of [
      ["deploy", "POST", "COGNITO_USER_POOLS"],
      ["schedule", "PATCH", "COGNITO_USER_POOLS"],
      ["connection", "POST", "COGNITO_USER_POOLS"],
      ["submit-flag", "POST", "NONE"],
    ]) {
      const logicalId = Object.entries(routes).find(
        ([, route]) => route.Properties.PathPart === path,
      )?.[0];
      expect(logicalId).toBeDefined();
      expect(
        methods.find(
          (method) =>
            method.Properties.HttpMethod === verb && method.Properties.ResourceId.Ref === logicalId,
        )?.Properties.AuthorizationType,
      ).toBe(authorization);
    }
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as {
          Action: string | string[];
          Effect: string;
          Resource: unknown;
        }[],
    );
    const assumptions = policies.filter(
      (policy) =>
        JSON.stringify(policy.Action).includes("sts:AssumeRole") && policy.Effect === "Allow",
    );
    expect(assumptions).toHaveLength(9);
    const legacy = assumptions.filter((assumption) => Array.isArray(assumption.Resource));
    expect(legacy).toHaveLength(4);
    for (const assumption of legacy)
      expect(assumption.Resource).toEqual(bindings.map((binding) => binding.roleArn));
    const registry = assumptions.filter(
      (assumption) =>
        !Array.isArray(assumption.Resource) && assumption.Resource !== "arn:aws:iam::*:role/*",
    );
    const participant = assumptions.filter(
      (assumption) => assumption.Resource === "arn:aws:iam::*:role/*",
    );
    expect(participant).toHaveLength(1);
    expect(participant[0]).toMatchObject({
      Condition: {
        StringEquals: {
          "aws:ResourceTag/TenkaCloud:Purpose": "participant-viewer",
          "aws:ResourceTag/TenkaCloud:OperatorAccount": "123456789012",
        },
      },
    });
    expect(registry).toHaveLength(4);
    for (const assumption of registry) {
      expect(assumption.Resource).toMatch(
        /^arn:aws:iam::\*:role\/TenkaCloud-[a-f0-9]{24}-deploy-Role$/u,
      );
      expect(assumption).toMatchObject({
        Condition: {
          StringEquals: {
            "aws:ResourceTag/TenkaCloud:Purpose": "competitor-deploy",
            "aws:ResourceTag/TenkaCloud:Installation": String(assumption.Resource).split("/")[1],
          },
        },
      });
    }
    expect(template.toJSON().Outputs.CloudRunnerMode.Value).toBe("registry-with-legacy-bindings");
    expect(template.toJSON().Outputs.CloudLegacyBindingsDigest.Value).toBe(
      contentDigest(JSON.stringify(bindings)),
    );
    const functions = Object.values(template.findResources("AWS::Lambda::Function"));
    for (const fn of functions) {
      const variables = fn.Properties.Environment?.Variables ?? {};
      expect(Buffer.byteLength(JSON.stringify(variables))).toBeLessThan(4096);
      expect(variables.CLOUD_RUNNER_BINDINGS).toBeUndefined();
    }
    const workerEnvironments = functions
      .filter((fn) => fn.Properties.Handler === "index.createHandler")
      .map((fn) => fn.Properties.Environment.Variables);
    expect(workerEnvironments).toHaveLength(1);
    expect(workerEnvironments[0].CLOUD_RUNNER_BINDINGS_KEY).toMatch(
      /^bindings\/[a-f0-9]{64}\.json$/,
    );
    const runtimeConfigs = readdirSync(directory)
      .map((name) => join(directory, name, "runtime-config.json"))
      .filter(existsSync)
      .map((path) => readFileSync(path, "utf8"));
    expect(runtimeConfigs.some((raw) => raw.includes('"hasAws":true'))).toBe(true);
    const catalogs = readdirSync(directory)
      .map((name) => join(directory, name, "catalogs"))
      .filter(existsSync)
      .flatMap((folder) => readdirSync(folder).map((name) => join(folder, name)));
    expect(catalogs.length).toBeGreaterThan(0);
    const raw = readFileSync(catalogs[0] ?? "", "utf8");
    expect(catalogs[0]).toContain(`${contentDigest(raw)}.json`);
    const catalog = JSON.parse(raw) as {
      problems: { templateBody: string; artifactDigest: string }[];
    };
    const source = readFileSync(
      join(root, "problems/challenges/hello-world/template.yaml"),
      "utf8",
    );
    expect(catalog.problems[0]?.templateBody).toBe(source);
    expect(catalog.problems[0]?.artifactDigest).toBe(contentDigest(source));
  }, 90_000);
});

function teardownFixture() {
  const f = fixture();
  const identity = { ...IDENTITY, operation: "delete" as const, generation: 1 };
  const owner = `${MACHINE.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(identity)}`;
  f.data.eventClosed = true;
  f.data.job = { ...f.data.job, owner: OWNER, status: "COMPLETE", stackId: f.stackId };
  f.data.creation = {
    ...IDENTITY,
    state: "ACKNOWLEDGED",
    owner: OWNER,
    leaseUntil: 0,
    stackId: f.stackId,
    fingerprint: deploymentIdentity(f.input).fingerprint,
  };
  f.data.teardown = {
    ...identity,
    status: "PENDING",
    requestedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
  f.stack.StackStatus = "CREATE_COMPLETE";
  const initial: WorkflowState = { identity, owner, phase: "pending", pollCount: 0 };
  return { ...f, initial };
}
describe("event-owned teardown through the existing workflow handlers", () => {
  it("persists the resolved original ARN before delete, polls, and completes without create or score writes", async () => {
    const f = teardownFixture();
    let state = await f.handlers.claim(f.initial);
    state = await f.handlers.create(state);
    expect(state.phase).toBe("pending");
    expect(state.deleteSubmitted).toBe(true);
    expect(f.recordTeardownReference).toHaveBeenCalledWith(
      f.initial.identity,
      f.initial.owner,
      state.reference,
    );
    expect(f.recordTeardownReference.mock.invocationCallOrder[0]).toBeLessThan(
      f.deleteStack.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.deleteStack.mock.calls[0]?.[0].StackName).toBe(f.stackId);
    f.stack.StackStatus = "DELETE_IN_PROGRESS";
    state = await f.handlers.describe(state);
    expect(state.phase).toBe("pending");
    f.stack.StackStatus = "DELETE_COMPLETE";
    state = await f.handlers.describe(state);
    expect(state.phase).toBe("ready");
    state = await f.handlers.finish(state);
    expect(f.data.job.status).toBe("DELETED");
    expect(f.data.teardown?.status).toBe("DELETED");
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.createStack).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain(PRIVATE_FLAG);
    expect((await f.handlers.finish(state)).phase).toBe("ready");
  });
  it("waits for the original create and its live request lease rather than deleting underneath it", async () => {
    const f = teardownFixture();
    f.data.job = { ...f.data.job, status: "IN_PROGRESS" };
    let state = await f.handlers.claim(f.initial);
    state = await f.handlers.create(state);
    expect(state.phase).toBe("pending");
    expect(f.describeStacks).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
    f.data.job = { ...f.data.job, status: "FAILED" };
    f.data.creation = { ...IDENTITY, owner: OWNER, state: "REQUESTED", leaseUntil: NOW + 60000 };
    state = await f.handlers.describe(state);
    expect(state.phase).toBe("pending");
    expect(f.deleteStack).not.toHaveBeenCalled();
    f.data.now = NOW + 60001;
    expect((await f.handlers.describe(state)).deleteSubmitted).toBe(true);
  });
  it("does not interpret an expired uncertain-create lease and missing name as successful cleanup", async () => {
    const f = teardownFixture();
    f.data.job = { ...f.data.job, status: "FAILED", stackId: undefined };
    f.data.creation = { ...IDENTITY, owner: OWNER, state: "REQUESTED", leaseUntil: NOW - 1 };
    f.describeStacks.mockRejectedValue(
      Object.assign(new Error(`Stack with id ${f.data.job.stackName} does not exist`), {
        name: "ValidationError",
      }),
    );
    const state = await f.handlers.claim(f.initial);
    await expect(f.handlers.create(state)).rejects.toThrow("could not complete");
    expect(f.deleteStack).not.toHaveBeenCalled();
    expect(f.finishTeardown).not.toHaveBeenCalled();
    await f.handlers.fail(state);
    expect(f.data.teardown?.status).toBe("FAILED");
    expect(f.data.job.status).not.toBe("DELETED");
  });
  it("permits the durably proved never-started case without issuing create or delete", async () => {
    const f = teardownFixture();
    f.data.job = { ...f.data.job, status: "FAILED", stackId: undefined };
    f.data.creation = { ...IDENTITY, state: "NOT_STARTED", leaseUntil: 0 };
    f.describeStacks.mockRejectedValue(
      Object.assign(new Error(`Stack with id ${f.data.job.stackName} does not exist`), {
        name: "ValidationError",
      }),
    );
    const state = await f.handlers.create(await f.handlers.claim(f.initial));
    expect(state.phase).toBe("ready");
    expect(state.reference).toBeUndefined();
    await f.handlers.finish(state);
    expect(f.data.teardown?.status).toBe("DELETED");
    expect(f.createStack).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
  });
  it("refuses a new create reservation after the event closes even when the workflow was already claimed", async () => {
    const f = fixture();
    const state = await f.handlers.claim(INITIAL);
    f.data.eventClosed = true;
    await expect(f.handlers.create(state)).rejects.toThrow("could not complete");
    expect(f.reserveCreation).toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.createStack).not.toHaveBeenCalled();
    expect((await f.handlers.fail(state)).phase).toBe("failed");
  });
  it("requires current binding authorization for cleanup without adopting the latest team connection", async () => {
    const f = teardownFixture();
    let state = await f.handlers.claim(f.initial);
    f.authorizeJob.mockRejectedValueOnce(new Error("binding withdrawn"));
    await expect(f.handlers.create(state)).rejects.toThrow("could not complete");
    expect(f.deleteStack).not.toHaveBeenCalled();
    f.getConnection.mockResolvedValue({ ...f.data.job.connection, version: 2 });
    f.data.job = { ...f.data.job, expiresAt: NOW / 1000 - 1 };
    state = await f.handlers.create(state);
    expect(state.deleteSubmitted).toBe(true);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(f.authorizeJob).toHaveBeenLastCalledWith(f.data.job);
  });
  it.each(["attempt", "generation", "owner", "event", "team"])(
    "rejects stale teardown %s before any remote call",
    async (changed) => {
      const f = teardownFixture();
      const state = await f.handlers.claim(f.initial);
      const altered = { ...state, identity: { ...state.identity } };
      if (changed === "attempt") altered.identity.attempt = 2;
      if (changed === "generation") altered.identity.generation = 2;
      if (changed === "owner") altered.owner = state.owner.replace("tc-delete", "tc-other");
      if (changed === "event") altered.identity.eventId = TEAM;
      if (changed === "team") altered.identity.teamId = EVENT;
      await expect(f.handlers.create(altered)).rejects.toThrow("could not complete");
      expect(f.deleteStack).not.toHaveBeenCalled();
    },
  );
  it("reconciles an interrupted delete and retries with a new fenced execution and token", async () => {
    const f = teardownFixture();
    const state = await f.handlers.create(await f.handlers.claim(f.initial));
    const originalToken = f.deleteStack.mock.calls[0]?.[0].ClientRequestToken;
    const describeExecution = vi.fn<RecoveryDependencies["describeExecution"]>(async () => ({
      stateMachineArn: MACHINE,
      executionArn: state.owner,
      status: "ABORTED",
      input: serializeDispatchIdentity(state.identity),
    }));
    const deps: RecoveryDependencies = {
      stateMachineArn: MACHINE,
      repository: {
        getJob: f.getJob,
        getTeardown: f.getTeardown,
        finishTeardown: f.finishTeardown,
        finish: f.finish,
        failPending: vi.fn(),
      },
      describeExecution,
      now: () => NOW,
    };
    const event = {
      source: "aws.states",
      "detail-type": "Step Functions Execution Status Change",
      detail: { stateMachineArn: MACHINE, executionArn: state.owner, status: "ABORTED" },
    };
    expect(await recoverTerminalExecution(event, deps)).toEqual({ outcome: "failed_owned" });
    expect(f.data.teardown?.stackId).toBe(f.stackId);
    const marker = f.data.teardown;
    if (!marker) throw new Error("Missing marker");
    f.data.teardown = { ...marker, generation: 2, status: "PENDING", owner: undefined };
    const identity = { ...state.identity, generation: 2 };
    const retry: WorkflowState = {
      identity,
      owner: `${MACHINE.replace(":stateMachine:", ":execution:")}:${dispatchExecutionName(identity)}`,
      phase: "pending",
      pollCount: 0,
    };
    f.stack.StackStatus = "DELETE_FAILED";
    await f.handlers.create(await f.handlers.claim(retry));
    expect(f.deleteStack.mock.calls[1]?.[0].ClientRequestToken).not.toBe(originalToken);
    await expect(f.handlers.finish({ ...state, phase: "ready" })).rejects.toThrow(
      "could not complete",
    );
  });
});

function historicalTeardownFixture() {
  const f = teardownFixture();
  const historical = { ...f.data.job, status: "FAILED" as const };
  f.data.historical = historical;
  f.data.job = {
    ...f.data.job,
    attempt: 2,
    status: "COMPLETE",
    awsAccountId: "222222222222",
    region: "us-west-2",
    catalogKey: `catalogs/${"c".repeat(64)}.json`,
    connection: {
      ...f.data.job.connection,
      version: 2,
      accountId: "222222222222",
      region: "us-west-2",
      roleArn: "arn:aws:iam::222222222222:role/TenkaCloudDeploy",
      externalIdParameter: "arn:aws:ssm:us-east-1:123456789012:parameter/cloud/new-team",
    },
  };
  f.getParameter.mockResolvedValue({
    Parameter: {
      ARN: historical.connection.externalIdParameter,
      Type: "SecureString",
      Value: "synthetic-external-id",
    },
  });
  return { ...f, historical };
}

describe("historical cleanup without changing current deployment authority", () => {
  it("uses the old account, region, catalog and physical ARN while preserving the immutable snapshot and current job", async () => {
    const f = historicalTeardownFixture();
    const current = structuredClone(f.data.job);
    const historical = structuredClone(f.data.historical);
    const cloudFormation = vi.fn(f.deps.runner.cloudFormation);
    const handlers = createWorkflowHandlers({
      ...f.deps,
      runner: { ...f.deps.runner, cloudFormation },
    });
    let state = await handlers.create(await handlers.claim(f.initial));
    expect(state.reference?.stackId).toBe(f.stackId);
    expect(f.resolveArtifacts).toHaveBeenCalledWith(f.historical);
    expect(f.authorizeJob).toHaveBeenCalledWith(f.historical);
    expect(f.assumeRole).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleArn: f.historical.connection.roleArn,
        ExternalId: "synthetic-external-id",
      }),
    );
    expect(cloudFormation).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "111111111111", region: "us-east-1" }),
    );
    expect(f.deleteStack).toHaveBeenCalledWith(expect.objectContaining({ StackName: f.stackId }));
    f.stack.StackStatus = "DELETE_COMPLETE";
    state = await handlers.describe(state);
    await handlers.finish(state);
    expect(f.data.teardown?.status).toBe("DELETED");
    expect(f.data.job).toEqual(current);
    expect(f.data.historical).toEqual(historical);
    expect(f.getConnection).not.toHaveBeenCalled();
    expect(f.getJob).not.toHaveBeenCalled();
    expect(f.createStack).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
  });

  it.each(["binding", "catalog", "snapshot"])(
    "fails closed when historical %s changes",
    async (changed) => {
      const f = historicalTeardownFixture();
      const state = await f.handlers.claim(f.initial);
      if (changed === "binding") f.authorizeJob.mockRejectedValue(new Error("old binding revoked"));
      if (changed === "catalog")
        f.resolveArtifacts.mockResolvedValue({
          templateBody: "Resources: {}",
          artifactDigest: "f".repeat(64),
          capabilities: [],
          publicOutputKeys: [],
        });
      if (changed === "snapshot") {
        f.resolveArtifacts.mockImplementation(async () => {
          f.data.historical = { ...f.historical, artifactDigest: "f".repeat(64) };
          return {
            templateBody: "Resources: {}",
            artifactDigest: f.historical.artifactDigest,
            capabilities: [],
            publicOutputKeys: ["ChallengeUrl"],
          };
        });
      }
      await expect(f.handlers.create(state)).rejects.toThrow("could not complete");
      expect(f.getParameter).not.toHaveBeenCalled();
      expect(f.deleteStack).not.toHaveBeenCalled();
      expect(f.finishTeardown).not.toHaveBeenCalled();
    },
  );

  it("cancels a prepared never-started current root without artifacts, authorization or STS", async () => {
    const f = teardownFixture();
    f.data.job = { ...f.data.job, status: "PENDING", stackId: undefined };
    f.data.creation = { ...IDENTITY, state: "NOT_STARTED", leaseUntil: 0 };
    f.resolveArtifacts.mockRejectedValue(new Error("artifact unavailable"));
    f.authorizeJob.mockRejectedValue(new Error("connection unavailable"));
    f.prepareDeletion.mockResolvedValueOnce(false);
    let state = await f.handlers.create(await f.handlers.claim(f.initial));
    expect(state.phase).toBe("pending");
    expect(f.finishTeardown).not.toHaveBeenCalled();
    state = await f.handlers.describe(state);
    expect(state.phase).toBe("ready");
    await f.handlers.finish(state);
    expect(f.data.teardown?.status).toBe("DELETED");
    expect(f.resolveArtifacts).not.toHaveBeenCalled();
    expect(f.authorizeJob).not.toHaveBeenCalled();
    expect(f.getParameter).not.toHaveBeenCalled();
    expect(f.assumeRole).not.toHaveBeenCalled();
    expect(f.describeStacks).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
  });

  it.each(["owner", "lease", "fingerprint", "empty-owner", "empty-fingerprint", "empty-stack"])(
    "does not accept non-pristine NOT_STARTED %s evidence",
    async (changed) => {
      const f = teardownFixture();
      f.data.job = { ...f.data.job, status: "FAILED", stackId: undefined };
      f.data.creation = {
        ...IDENTITY,
        state: "NOT_STARTED",
        leaseUntil: changed === "lease" ? -1 : 0,
        ...(changed === "owner" ? { owner: OWNER } : {}),
        ...(changed === "fingerprint" ? { fingerprint: "f".repeat(64) } : {}),
        ...(changed === "empty-owner" ? { owner: "" } : {}),
        ...(changed === "empty-fingerprint" ? { fingerprint: "" } : {}),
        ...(changed === "empty-stack" ? { stackId: "" } : {}),
      };
      f.describeStacks.mockRejectedValue(
        Object.assign(new Error(`Stack with id ${f.data.job.stackName} does not exist`), {
          name: "ValidationError",
        }),
      );
      await expect(f.handlers.create(await f.handlers.claim(f.initial))).rejects.toThrow(
        "could not complete",
      );
      expect(f.finishTeardown).not.toHaveBeenCalled();
    },
  );
});

function historicalDispatchFixture(claimed = false) {
  const f = historicalTeardownFixture();
  const marker = f.data.teardown;
  if (!marker) throw new Error("Missing historical marker");
  if (claimed) f.data.teardown = { ...marker, status: "IN_PROGRESS", owner: f.initial.owner };
  const describeExecution = vi.fn<DispatchDependencies["describeExecution"]>(async () => ({
    stateMachineArn: MACHINE,
    executionArn: f.initial.owner,
    status: "ABORTED",
    input: serializeDispatchIdentity(f.initial.identity),
  }));
  const startExecution = vi.fn<DispatchDependencies["startExecution"]>(async () => {
    throw Object.assign(new Error("already exists"), { name: "ExecutionAlreadyExists" });
  });
  const deps: DispatchDependencies = {
    repository: {
      getDeletionJob: f.getDeletionJob,
      getTeardown: f.getTeardown,
      finishTeardown: f.finishTeardown,
      acceptingNewDeployments: async () => false,
      listDispatch: async () => [{ ...f.initial.identity, createdAt: new Date(NOW).toISOString() }],
    },
    stateMachineArn: MACHINE,
    startExecution,
    describeExecution,
    now: () => NOW,
  };
  return { ...f, workflowDependencies: f.deps, deps, startExecution, describeExecution };
}

describe("historical duplicate execution recovery across c091 workers", () => {
  it.each([false, true])(
    "rescues historical work after c091-style stale recovery, claimed=%s",
    async (claimed) => {
      const f = historicalDispatchFixture(claimed);
      // c091 selects the job-level TEARDOWN, whose current attempt cannot match this child.
      const legacyGetTeardown = vi.fn<WorkflowRepository["getTeardown"]>(async () => {
        throw new DeploymentConflict("teardown_scope_or_generation_changed");
      });
      const legacyWorker = createWorkflowHandlers({
        ...f.workflowDependencies,
        repository: { ...f.workflowDependencies.repository, getTeardown: legacyGetTeardown },
      });
      await expect(legacyWorker.claim(f.initial)).rejects.toThrow("could not complete");
      const event = {
        source: "aws.states",
        "detail-type": "Step Functions Execution Status Change",
        detail: { stateMachineArn: MACHINE, executionArn: f.initial.owner, status: "ABORTED" },
      };
      expect(
        await recoverTerminalExecution(event, {
          ...f.deps,
          repository: {
            getJob: f.getJob,
            finish: f.finish,
            failPending: vi.fn(),
            getTeardown: legacyGetTeardown,
            finishTeardown: f.finishTeardown,
          },
        }),
      ).toEqual({ outcome: "stale" });
      expect(f.finishTeardown).not.toHaveBeenCalled();
      // An explicit DELETE republishes the original generation; the dispatcher never takes it over.
      expect(await dispatchPending(f.deps)).toEqual({
        pending: 1,
        started: 0,
        duplicate: 1,
        uncertain: 0,
      });
      expect(f.finishTeardown).toHaveBeenCalledExactlyOnceWith(
        f.initial.identity,
        claimed ? f.initial.owner : undefined,
        { status: "FAILED", failureReason: "workflow_aborted" },
        new Date(NOW).toISOString(),
      );
      expect(f.data.teardown?.generation).toBe(1);
      expect(f.data.job.attempt).toBe(2);
      expect(f.data.job.status).toBe("COMPLETE");
      expect(f.startExecution.mock.calls[0]?.[0].input).toBe(
        serializeDispatchIdentity(f.initial.identity),
      );
    },
  );

  it.each(["RUNNING", "SUCCEEDED", "PENDING_REDRIVE", undefined])(
    "leaves %s execution ownership untouched",
    async (status) => {
      const f = historicalDispatchFixture(true);
      f.describeExecution.mockResolvedValue({
        stateMachineArn: MACHINE,
        executionArn: f.initial.owner,
        status,
        input: serializeDispatchIdentity(f.initial.identity),
      });
      expect((await dispatchPending(f.deps)).duplicate).toBe(1);
      expect(f.finishTeardown).not.toHaveBeenCalled();
      expect(f.data.teardown?.owner).toBe(f.initial.owner);
      expect(f.data.teardown?.status).toBe("IN_PROGRESS");
    },
  );

  it.each(["machine", "arn", "input", "scope", "whitespace"])(
    "rejects %s mismatch without changing a child",
    async (changed) => {
      const f = historicalDispatchFixture();
      let input = serializeDispatchIdentity(f.initial.identity);
      if (changed === "input")
        input = serializeDispatchIdentity({ ...f.initial.identity, generation: 2 });
      if (changed === "scope")
        input = serializeDispatchIdentity({ ...f.initial.identity, eventId: TEAM });
      if (changed === "whitespace") input = ` ${input}`;
      f.describeExecution.mockResolvedValue({
        stateMachineArn: changed === "machine" ? `${MACHINE}Other` : MACHINE,
        executionArn: changed === "arn" ? `${f.initial.owner}-other` : f.initial.owner,
        status: "FAILED",
        input,
      });
      expect((await dispatchPending(f.deps)).uncertain).toBe(1);
      expect(f.finishTeardown).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "generation", "pending-owner", "running-unowned"])(
    "does not reconcile %s marker",
    async (changed) => {
      const f = historicalDispatchFixture(true);
      const marker = f.data.teardown;
      if (!marker) throw new Error("Missing historical marker");
      f.data.teardown = {
        ...marker,
        ...(changed === "owner" ? { owner: `${f.initial.owner}-other` } : {}),
        ...(changed === "generation" ? { generation: 2 } : {}),
        ...(changed === "pending-owner" ? { status: "PENDING" } : {}),
        ...(changed === "running-unowned" ? { owner: undefined } : {}),
      };
      await dispatchPending(f.deps);
      expect(f.finishTeardown).not.toHaveBeenCalled();
    },
  );
});
