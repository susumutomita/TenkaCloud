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
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CloudApplicationStack } from "../../lib/cloud-hosting/application-stack.js";
import { CloudDataStack } from "../../lib/cloud-hosting/data-stack.js";
import { CloudDeploymentPipeline } from "../../lib/cloud-hosting/deployment-pipeline.js";
import {
  contentDigest,
  type DeploymentJob,
  deploymentStackName,
  flagDigest,
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
  const data: { job: DeploymentJob } = {
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
  const getJob = vi.fn<WorkflowRepository["getJob"]>(async () => structuredClone(data.job));
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
    repository: { getJob, getConnection, begin, finish },
    resolveArtifacts,
    authorizeJob,
    now: () => NOW,
    runner: {
      ssm: () => ({ getParameter }),
      sts: { assumeRole },
      cloudFormation: () => ({ describeStacks, createStack }),
      now: () => NOW,
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
    getConnection,
    getParameter,
    assumeRole,
    describeStacks,
    createStack,
    resolveArtifacts,
    authorizeJob,
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
        bindingId: "approved",
        reviewedProblemIds: ["hello-world"],
      },
    };
    const binding = {
      id: "approved",
      accountId: f.data.job.awsAccountId,
      region: f.data.job.region,
      roleArn: f.data.job.connection.roleArn,
      externalIdParameterArn: f.data.job.connection.externalIdParameter,
      reviewedProblemIds: ["hello-world"],
    };
    let raw = JSON.stringify([binding]);
    for (const [key, value] of Object.entries({
      AWS_REGION: "us-east-1",
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
      if (!(command instanceof GetCommand)) throw new Error("Unexpected mutating Dynamo command");
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
    const handlers = await createProductionWorkflowHandlers(f.resolveArtifacts);
    expect((await handlers.create(INITIAL)).phase).toBe("pending");
    const calls = sts.mock.calls.length;
    const cfnCalls = cfn.mock.calls.length;
    raw = JSON.stringify([{ ...binding, id: "withdrawn" }]);
    vi.stubEnv("CLOUD_RUNNER_BINDINGS_KEY", `bindings/${contentDigest(raw)}.json`);
    const withdrawn = await createProductionWorkflowHandlers(f.resolveArtifacts);
    await expect(withdrawn.create(INITIAL)).rejects.toThrow("could not complete");
    expect(sts).toHaveBeenCalledTimes(calls);
    expect(cfn).toHaveBeenCalledTimes(cfnCalls);
  });
});

describe("scheduled durable intent dispatcher", () => {
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
    const deps = { repository: { listDispatch }, stateMachineArn: MACHINE, startExecution };
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
    expect(Object.keys(deps.repository)).toEqual(["listDispatch"]);
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
    const deps = { repository: { listDispatch }, stateMachineArn: MACHINE, startExecution };
    expect((await dispatchPending(deps, { limit: 500, concurrency: 5 })).started).toBe(500);
    expect(peak).toBe(5);
    expect(listDispatch).toHaveBeenCalledWith(500);
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
      repository: { getJob: f.getJob, finish: f.finish, failPending },
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
      EVENTS_TABLE_NAME: "synthetic-events",
      TEAMS_TABLE_NAME: "synthetic-teams",
      DEPLOYMENTS_TABLE_NAME: "synthetic-deployments",
      DEPLOYMENT_STATE_MACHINE_ARN: MACHINE,
    }))
      vi.stubEnv(key, value);
    const send = vi
      .spyOn(SFNClient.prototype, "send")
      .mockImplementation(async () => ({ $metadata: {}, executionArn: OWNER }));
    const dispatch = createAwsDispatcherDependencies();
    await dispatch.startExecution({
      stateMachineArn: MACHINE,
      name: dispatchExecutionName(IDENTITY),
      input: serializeDispatchIdentity(IDENTITY),
    });
    const recoveryDeps = createAwsRecoveryDependencies();
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
      events: table("Events"),
      teams: table("Teams"),
      deployments: table("Deployments"),
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
          Resource: unknown;
        }[],
    );
    const assumes = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes("sts:AssumeRole"),
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
      ReservedConcurrentExecutions: 1,
    });
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
    const backend = new CloudDataStack(app, "ApplicationData", { env, participantAssets: assets });
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
          Resource: unknown;
        }[],
    );
    const assumptions = policies.filter((policy) =>
      JSON.stringify(policy.Action).includes("sts:AssumeRole"),
    );
    expect(assumptions).toHaveLength(4);
    for (const assumption of assumptions)
      expect(assumption.Resource).toEqual(bindings.map((binding) => binding.roleArn));
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
    expect(runtimeConfigs.some((raw) => raw.includes('"hasAws":false'))).toBe(true);
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
