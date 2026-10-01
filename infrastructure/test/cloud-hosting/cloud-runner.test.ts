import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackResourceCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CloudDeploymentInput,
  type CloudFormationTransport,
  type CloudRunnerDependencies,
  createDeployment,
  type DeploymentReference,
  deleteDeployment,
  deploymentIdentity,
  deploymentOwnershipTags,
  describeDeletion,
  describeDeployment,
  describeParticipantTarget,
  MAX_DEPLOYMENT_INPUT_BYTES,
  parseDeploymentInput,
  pollDeployment,
  type StackDescription,
  type StsTransport,
  serializeDeploymentInput,
} from "../../lib/problem-deploy/handlers/cloud-runner/index.js";
import { createAwsCloudRunnerDependencies } from "../../lib/problem-deploy/handlers/cloud-runner/sdk.js";

afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse("2026-10-01T09:00:00Z");
const EXTERNAL_ID = "synthetic-external-id-for-tests";
const UNSUPPORTED_REGIONS = [
  "cn-north-1",
  "cn-northwest-1",
  "us-gov-west-1",
  "us-iso-east-1",
  "us-isob-east-1",
  "eu-isoe-west-1",
  "eusc-de-east-1",
];
const INPUT: CloudDeploymentInput = {
  version: 1,
  eventId: "event-a",
  teamId: "team-a",
  problemId: "flag-one",
  jobId: "job-a",
  attemptId: "attempt-a",
  target: {
    accountId: "123456789012",
    region: "us-east-1",
    roleArn: "arn:aws:iam::123456789012:role/TenkaCloudDeploy",
    externalIdParameterArn: "arn:aws:ssm:us-west-2:999999999999:parameter/cloud/event-a/team-a",
  },
  templateBody: "Resources: {Marker: {Type: AWS::SSM::Parameter}}",
  parameters: [{ key: "NamePrefix", value: "event-a-team-a" }],
  capabilities: [],
  allowedOutputKeys: ["ChallengeUrl"],
};

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function fixture(value: unknown = INPUT) {
  const input = parseDeploymentInput(value);
  const identity = deploymentIdentity(input);
  const stackId = `arn:aws:cloudformation:${input.target.region}:${input.target.accountId}:stack/${identity.stackName}/synthetic-stack-id`;
  const ownedStack = (changes: Partial<StackDescription> = {}): StackDescription => ({
    StackId: stackId,
    StackName: identity.stackName,
    StackStatus: "CREATE_COMPLETE",
    Tags: deploymentOwnershipTags(input),
    Outputs: [
      { OutputKey: "ChallengeUrl", OutputValue: "https://challenge.example.test" },
      { OutputKey: "AdminPassword", OutputValue: "synthetic-not-for-participants" },
    ],
    ...changes,
  });
  const describeStacks = vi.fn<CloudFormationTransport["describeStacks"]>(async ({ StackName }) => {
    throw namedError("ValidationError", `Stack with id ${StackName} does not exist`);
  });
  const createStack = vi.fn<CloudFormationTransport["createStack"]>(async () => ({
    StackId: stackId,
  }));
  const deleteStack = vi.fn<CloudFormationTransport["deleteStack"]>(async () => ({}));
  const getParameter = vi.fn(async () => ({
    Parameter: {
      ARN: input.target.externalIdParameterArn,
      Type: "SecureString",
      Value: EXTERNAL_ID,
    },
  }));
  const assumeRole = vi.fn<StsTransport["assumeRole"]>(async () => ({
    Credentials: {
      AccessKeyId: "SYNTHETIC_ACCESS_KEY",
      SecretAccessKey: "synthetic-secret",
      SessionToken: "synthetic-session",
      Expiration: new Date(NOW + 15 * 60_000),
    },
  }));
  const cloudFormation = vi.fn(() => ({ describeStacks, createStack, deleteStack }));
  const ssm = vi.fn(() => ({ getParameter }));
  const deps: CloudRunnerDependencies = {
    ssm,
    sts: { assumeRole },
    cloudFormation,
    now: () => NOW,
  };
  const reference = { stackId, fingerprint: identity.fingerprint };
  return {
    input,
    identity,
    stackId,
    reference,
    deps,
    ownedStack,
    describeStacks,
    createStack,
    deleteStack,
    getParameter,
    assumeRole,
    cloudFormation,
    ssm,
  };
}

describe("bounded immutable cloud deployment snapshots", () => {
  it("canonicalizes, clones and deeply freezes serialized input", () => {
    const source = structuredClone(INPUT);
    const result = parseDeploymentInput(source);
    expect(result).not.toBe(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Object.isFrozen(result.parameters)).toBe(true);
    expect(Object.isFrozen(result.parameters[0])).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.allowedOutputKeys)).toBe(true);
    expect(parseDeploymentInput(serializeDeploymentInput(result))).toEqual(result);
    const params = [
      { key: "Zebra", value: "a" },
      { key: "Alpha", value: "b" },
    ];
    expect(serializeDeploymentInput({ ...INPUT, parameters: params })).toBe(
      serializeDeploymentInput({ ...INPUT, parameters: [...params].reverse() }),
    );
  });

  it.each([
    { eventId: "" },
    { teamId: "team with spaces" },
    { attemptId: "x".repeat(129) },
    { extra: "not allowed" },
    { templateBody: "a".repeat(51_201) },
    { templateBody: "あ".repeat(17_067) },
    {
      parameters: [
        { key: "Duplicated", value: "a" },
        { key: "Duplicated", value: "b" },
      ],
    },
    { capabilities: ["CAPABILITY_AUTO_EXPAND"] },
    { allowedOutputKeys: ["ChallengeUrl", "ChallengeUrl"] },
    { allowedOutputKeys: Array.from({ length: 17 }, (_, i) => `Output${i}`) },
    { target: { ...INPUT.target, roleArn: "arn:aws:iam::000000000000:role/Other" } },
    { target: { ...INPUT.target, roleArn: "" } },
    { target: { ...INPUT.target, externalIdParameterArn: "" } },
    { target: { ...INPUT.target, region: "us-gov-west-1" } },
  ])("rejects invalid snapshots before any transport call: %j", async (change) => {
    const f = fixture();
    await expect(createDeployment({ ...INPUT, ...change }, f.deps)).rejects.toThrow();
    expect(f.ssm).not.toHaveBeenCalled();
    expect(f.assumeRole).not.toHaveBeenCalled();
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });

  it.each(UNSUPPORTED_REGIONS)(
    "rejects target and ExternalId parameter region %s before transport access",
    async (region) => {
      for (const target of [
        { ...INPUT.target, region },
        {
          ...INPUT.target,
          externalIdParameterArn: `arn:aws:ssm:${region}:999999999999:parameter/cloud/team`,
        },
      ]) {
        const f = fixture();
        await expect(createDeployment({ ...INPUT, target }, f.deps)).rejects.toThrow(
          "Invalid cloud deployment input",
        );
        expect(f.ssm).not.toHaveBeenCalled();
        expect(f.assumeRole).not.toHaveBeenCalled();
        expect(f.cloudFormation).not.toHaveBeenCalled();
      }
    },
  );

  it("accepts commercial target and secret regions from the shared hosting contract", () => {
    expect(
      parseDeploymentInput({
        ...INPUT,
        target: {
          ...INPUT.target,
          region: "il-central-1",
          externalIdParameterArn: "arn:aws:ssm:mx-central-1:999999999999:parameter/cloud/team",
        },
      }).target.region,
    ).toBe("il-central-1");
  });

  it("bounds the whole serialized snapshot, including multibyte parameter values", () => {
    expect(() => parseDeploymentInput(" ".repeat(MAX_DEPLOYMENT_INPUT_BYTES + 1))).toThrow("size");
    expect(() => parseDeploymentInput("{bad-json")).toThrow("valid JSON");
    expect(() =>
      parseDeploymentInput({
        ...INPUT,
        parameters: Array.from({ length: 40 }, (_, i) => ({
          key: `Param${i}`,
          value: "a".repeat(4000),
        })),
      }),
    ).toThrow("size");
  });

  it("separates event/team/problem stack names and fingerprints every job/attempt", () => {
    const original = deploymentIdentity(parseDeploymentInput(INPUT));
    for (const field of ["eventId", "teamId", "problemId"] as const) {
      expect(
        deploymentIdentity(parseDeploymentInput({ ...INPUT, [field]: "another" })).stackName,
      ).not.toBe(original.stackName);
    }
    for (const field of ["jobId", "attemptId"] as const) {
      const changed = deploymentIdentity(parseDeploymentInput({ ...INPUT, [field]: "another" }));
      expect(changed.stackName).toBe(original.stackName);
      expect(changed.fingerprint).not.toBe(original.fingerprint);
    }
    const changed = deploymentIdentity(parseDeploymentInput({ ...INPUT, templateBody: "changed" }));
    expect(changed.stackName).toBe(original.stackName);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.clientRequestToken).not.toBe(original.clientRequestToken);
  });
});

describe("read-only participant viewer ownership", () => {
  function participantFixture() {
    const base = { ...INPUT, problemId: "hello-world" };
    const name = deploymentIdentity(parseDeploymentInput(base)).stackName;
    const f = fixture({
      ...base,
      parameters: [
        { key: "NamePrefix", value: name },
        { key: "ExternalId", value: INPUT.jobId },
      ],
    });
    const physicalRole = "SyntheticTruncatedName-Viewer-A1B2C3";
    const roleArn = `arn:aws:iam::${INPUT.target.accountId}:role/${physicalRole}`;
    const detail = {
      StackId: f.stackId,
      LogicalResourceId: "ParticipantViewerRole",
      PhysicalResourceId: physicalRole,
      ResourceType: "AWS::IAM::Role",
      ResourceStatus: "CREATE_COMPLETE",
    };
    const resource = vi.fn(async () => ({ StackResourceDetail: detail }));
    const outputs = [
      { OutputKey: "ParticipantViewerRoleArn", OutputValue: roleArn },
      { OutputKey: "ParameterName", OutputValue: `/${name}/hello` },
      { OutputKey: "PrivateFlag", OutputValue: "SYNTHETIC-MUST-NOT-ESCAPE" },
    ];
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ Outputs: outputs })] });
    return {
      ...f,
      detail,
      outputs,
      resource,
      roleArn,
      name,
      deps: {
        ...f.deps,
        cloudFormation: () => ({
          describeStacks: f.describeStacks,
          describeStackResource: resource,
          createStack: f.createStack,
          deleteStack: f.deleteStack,
        }),
      },
    };
  }
  it("binds the physical viewer and exact parameter to the original stack without changing request fingerprint", async () => {
    const f = participantFixture();
    const result = await describeParticipantTarget(f.input, f.reference, f.deps);
    expect(result).toEqual({
      roleArn: f.roleArn,
      parameterArn: `arn:aws:ssm:us-east-1:123456789012:parameter/${f.name}/hello`,
    });
    expect(f.resource).toHaveBeenCalledWith({
      StackName: f.stackId,
      LogicalResourceId: "ParticipantViewerRole",
    });
    expect(f.describeStacks).toHaveBeenCalledWith({ StackName: f.stackId });
    expect(f.createStack).not.toHaveBeenCalled();
    expect(f.deleteStack).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-MUST-NOT-ESCAPE");
    expect(f.input.allowedOutputKeys).not.toContain("ParticipantViewerRoleArn");
  });
  it.each([
    { StackId: "another-stack" },
    { LogicalResourceId: "AnotherRole" },
    { ResourceType: "AWS::SSM::Parameter" },
    { ResourceStatus: "DELETE_IN_PROGRESS" },
    { PhysicalResourceId: "../role" },
    { PhysicalResourceId: "x".repeat(65) },
  ])("rejects a different physical resource: %j", async (change) => {
    const f = participantFixture();
    f.resource.mockResolvedValue({ StackResourceDetail: { ...f.detail, ...change } });
    await expect(describeParticipantTarget(f.input, f.reference, f.deps)).rejects.toThrow(
      "original stack",
    );
  });
  it.each(["ParticipantViewerRoleArn", "ParameterName"])(
    "rejects another team's %s output",
    async (key) => {
      const f = participantFixture();
      f.describeStacks.mockResolvedValue({
        Stacks: [
          f.ownedStack({
            Outputs: f.outputs.map((output) =>
              output.OutputKey === key
                ? { ...output, OutputValue: `${output.OutputValue}-another-team` }
                : output,
            ),
          }),
        ],
      });
      await expect(describeParticipantTarget(f.input, f.reference, f.deps)).rejects.toThrow(
        "owned resource",
      );
    },
  );
  it("rejects stale attempts before reading any viewer resource", async () => {
    const f = participantFixture();
    f.describeStacks.mockResolvedValue({
      Stacks: [f.ownedStack({ Tags: deploymentOwnershipTags({ ...f.input, attemptId: "old" }) })],
    });
    await expect(describeParticipantTarget(f.input, f.reference, f.deps)).rejects.toThrow(
      "ownership",
    );
    expect(f.resource).not.toHaveBeenCalled();
  });
  it("uses an explicitly assumed competitor client for the SDK resource lookup", async () => {
    const send = vi
      .spyOn(CloudFormationClient.prototype, "send")
      .mockImplementation(async () => ({}));
    const deps = createAwsCloudRunnerDependencies({ controlPlaneRegion: "us-east-1" });
    const client = deps.cloudFormation({
      region: "us-east-1",
      accountId: "123456789012",
      credentials: {
        accessKeyId: "SYNTHETICKEY",
        secretAccessKey: "synthetic-secret",
        sessionToken: "synthetic-token",
        expiration: new Date(NOW + 900_000),
      },
    });
    await client.describeStackResource?.({
      StackName: "original-stack-arn",
      LogicalResourceId: "ParticipantViewerRole",
    });
    expect(send).toHaveBeenCalledWith(expect.any(DescribeStackResourceCommand));
    expect(send.mock.calls[0]?.[0].input).toEqual({
      StackName: "original-stack-arn",
      LogicalResourceId: "ParticipantViewerRole",
    });
  });
});

describe("required ExternalId and assumed target credentials", () => {
  it("uses the explicit SSM region and ARN, requires ExternalId, and never supplies ambient credentials", async () => {
    const f = fixture();
    const result = await createDeployment(serializeDeploymentInput(INPUT), f.deps);
    expect(f.ssm).toHaveBeenCalledWith("us-west-2");
    expect(f.getParameter).toHaveBeenCalledWith({
      Name: INPUT.target.externalIdParameterArn,
      WithDecryption: true,
    });
    expect(f.assumeRole).toHaveBeenCalledWith({
      RoleArn: INPUT.target.roleArn,
      ExternalId: EXTERNAL_ID,
      RoleSessionName: expect.stringMatching(/^tc-[a-f0-9]{48}$/),
      DurationSeconds: 900,
    });
    expect(f.cloudFormation).toHaveBeenCalledWith({
      region: INPUT.target.region,
      accountId: INPUT.target.accountId,
      credentials: {
        accessKeyId: "SYNTHETIC_ACCESS_KEY",
        secretAccessKey: "synthetic-secret",
        sessionToken: "synthetic-session",
        expiration: new Date(NOW + 15 * 60_000),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|synthetic-session|external-id/);
  });

  it.each([
    { Type: "String" },
    { Value: "" },
    { Value: "with spaces" },
    { ARN: "arn:aws:ssm:us-west-2:999999999999:parameter/another-team" },
  ])("rejects a missing or incorrect ExternalId parameter: %j", async (change) => {
    const f = fixture();
    f.getParameter.mockResolvedValue({
      Parameter: {
        ARN: INPUT.target.externalIdParameterArn,
        Type: "SecureString",
        Value: EXTERNAL_ID,
        ...change,
      },
    });
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("SecureString ExternalId");
    expect(f.assumeRole).not.toHaveBeenCalled();
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });

  it.each([
    { AccessKeyId: "" },
    { SecretAccessKey: "" },
    { SessionToken: "" },
    { Expiration: new Date(NOW) },
    { Expiration: new Date(Number.NaN) },
  ])("rejects incomplete or expired credentials without falling back: %j", async (change) => {
    const f = fixture();
    f.assumeRole.mockResolvedValue({
      Credentials: {
        AccessKeyId: "SYNTHETIC_ACCESS_KEY",
        SecretAccessKey: "synthetic-secret",
        SessionToken: "synthetic-session",
        Expiration: new Date(NOW + 900_000),
        ...change,
      },
    });
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("incomplete or expired");
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });

  it("propagates authorization errors and does not fetch a prior ExternalId version", async () => {
    const f = fixture();
    const denied = namedError("AccessDenied", "synthetic denied");
    f.assumeRole.mockRejectedValue(denied);
    await expect(createDeployment(INPUT, f.deps)).rejects.toBe(denied);
    expect(f.getParameter).toHaveBeenCalledTimes(1);
    expect(f.assumeRole).toHaveBeenCalledTimes(1);
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });
});

describe("create-only deployment ownership and idempotency", () => {
  it("creates with deterministic ownership tags/token and retains failures for explicit recovery", async () => {
    const f = fixture();
    const first = await createDeployment(INPUT, f.deps);
    const second = await createDeployment(INPUT, f.deps);
    expect(first).toEqual(second);
    expect(first).toEqual({
      operation: "created",
      phase: "pending",
      stackStatus: "CREATE_IN_PROGRESS",
      reference: f.reference,
      outputs: {},
    });
    expect(f.createStack.mock.calls[0]).toEqual(f.createStack.mock.calls[1]);
    expect(f.createStack).toHaveBeenCalledWith({
      StackName: f.identity.stackName,
      TemplateBody: INPUT.templateBody,
      Parameters: [{ ParameterKey: "NamePrefix", ParameterValue: "event-a-team-a" }],
      Capabilities: [],
      Tags: deploymentOwnershipTags(f.input),
      ClientRequestToken: f.identity.clientRequestToken,
      OnFailure: "DO_NOTHING",
      TimeoutInMinutes: 30,
    });
  });

  it.each(["CREATE_IN_PROGRESS", "CREATE_COMPLETE", "CREATE_FAILED", "ROLLBACK_COMPLETE"])(
    "resumes only an exactly owned attempt in %s without update or delete",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      expect((await createDeployment(INPUT, f.deps)).operation).toBe("existing");
      expect(f.createStack).not.toHaveBeenCalled();
    },
  );

  it.each([
    "EventId",
    "TeamId",
    "ProblemId",
    "JobId",
    "AttemptId",
    "AccountId",
    "Region",
    "RequestFingerprint",
  ])("refuses a stack with mismatched %s before using its status or outputs", async (field) => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({
      Stacks: [
        f.ownedStack({
          Tags: deploymentOwnershipTags(f.input).map((tag) =>
            tag.Key === `TenkaCloud:${field}` ? { ...tag, Value: "other" } : tag,
          ),
        }),
      ],
    });
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("ownership");
    await expect(describeDeployment(INPUT, f.reference, f.deps)).rejects.toThrow("ownership");
    expect(f.createStack).not.toHaveBeenCalled();
  });

  it.each([
    [],
    undefined,
    [
      ...deploymentOwnershipTags(parseDeploymentInput(INPUT)),
      { Key: "TenkaCloud:TeamId", Value: "team-a" },
    ],
  ])("rejects missing and duplicate ownership tags", async (Tags) => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ Tags })] });
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("ownership");
    expect(f.createStack).not.toHaveBeenCalled();
  });

  it("refuses a changed template/role/ExternalId binding under the same owned attempt", async () => {
    const f = fixture();
    for (const change of [
      { templateBody: "changed" },
      { target: { ...INPUT.target, roleArn: "arn:aws:iam::123456789012:role/Other" } },
      {
        target: {
          ...INPUT.target,
          externalIdParameterArn: `${INPUT.target.externalIdParameterArn}-other`,
        },
      },
      { attemptId: "attempt-b" },
    ]) {
      const changed = fixture({ ...INPUT, ...change });
      changed.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack()] });
      await expect(createDeployment(changed.input, changed.deps)).rejects.toThrow("ownership");
      expect(changed.createStack).not.toHaveBeenCalled();
    }
  });

  it("recovers an already-exists race only after verifying all ownership fields", async () => {
    const f = fixture();
    f.createStack.mockRejectedValue(namedError("AlreadyExistsException", "already exists"));
    f.describeStacks
      .mockRejectedValueOnce(
        namedError("ValidationError", `Stack with id ${f.identity.stackName} does not exist`),
      )
      .mockResolvedValueOnce({ Stacks: [f.ownedStack()] });
    expect((await createDeployment(INPUT, f.deps)).operation).toBe("existing");
    expect(f.createStack).toHaveBeenCalledTimes(1);
    const wrong = fixture();
    wrong.createStack.mockRejectedValue(namedError("AlreadyExistsException", "already exists"));
    wrong.describeStacks
      .mockRejectedValueOnce(
        namedError("ValidationError", `Stack with id ${wrong.identity.stackName} does not exist`),
      )
      .mockResolvedValueOnce({ Stacks: [wrong.ownedStack({ Tags: [] })] });
    await expect(createDeployment(INPUT, wrong.deps)).rejects.toThrow("ownership");
  });

  it("does not mistake access denial, throttling, malformed responses or other missing-stack text for absence", async () => {
    for (const error of [
      namedError("AccessDenied", "Stack with id example does not exist"),
      namedError("ThrottlingException", "too many requests"),
      namedError("ValidationError", "Stack with id unrelated-stack does not exist"),
    ]) {
      const f = fixture();
      f.describeStacks.mockRejectedValue(error);
      await expect(createDeployment(INPUT, f.deps)).rejects.toBe(error);
      expect(f.createStack).not.toHaveBeenCalled();
    }
    const malformed = fixture();
    malformed.describeStacks.mockResolvedValue({ Stacks: [] });
    await expect(createDeployment(INPUT, malformed.deps)).rejects.toThrow("ambiguous");
    expect(malformed.createStack).not.toHaveBeenCalled();
  });

  it("rejects a wrong-account/region/name physical stack and an invalid create response", async () => {
    for (const replace of [
      (value: string) => value.replace("123456789012", "000000000000"),
      (value: string) => value.replace("us-east-1", "us-west-2"),
      (value: string) => value.replace("stack/tc-", "stack/other-"),
    ]) {
      const f = fixture();
      f.describeStacks.mockResolvedValue({
        Stacks: [f.ownedStack({ StackId: replace(f.stackId) })],
      });
      await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("identity");
    }
    const f = fixture();
    f.createStack.mockResolvedValue({});
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("identity");
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackName: "other" })] });
    await expect(createDeployment(INPUT, f.deps)).rejects.toThrow("stack name");
  });
});

describe("owned status polling and participant output whitelist", () => {
  it("polls pending to ready with fresh assumed credentials and returns only allowed outputs", async () => {
    const f = fixture();
    f.describeStacks
      .mockResolvedValueOnce({ Stacks: [f.ownedStack({ StackStatus: "CREATE_IN_PROGRESS" })] })
      .mockResolvedValueOnce({ Stacks: [f.ownedStack()] });
    const wait = vi.fn(async () => undefined);
    const result = await pollDeployment(INPUT, f.reference, f.deps, {
      maxPolls: 3,
      intervalMs: 5000,
      wait,
    });
    expect(result.phase).toBe("ready");
    expect(result.outputs).toEqual({ ChallengeUrl: "https://challenge.example.test" });
    expect(JSON.stringify(result)).not.toContain("AdminPassword");
    expect(wait).toHaveBeenCalledExactlyOnceWith(5000);
    expect(f.assumeRole).toHaveBeenCalledTimes(2);
    expect(f.describeStacks).toHaveBeenCalledWith({ StackName: f.stackId });
  });

  it.each(["CREATE_FAILED", "ROLLBACK_COMPLETE", "DELETE_IN_PROGRESS"])(
    "stops in %s without exposing any outputs",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      const wait = vi.fn(async () => undefined);
      const result = await pollDeployment(INPUT, f.reference, f.deps, {
        maxPolls: 3,
        intervalMs: 1000,
        wait,
      });
      expect(result.phase).toBe("failed");
      expect(result.outputs).toEqual({});
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it("leaves polling exhaustion pending and validates bounds before calling AWS", async () => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({
      Stacks: [f.ownedStack({ StackStatus: "CREATE_IN_PROGRESS" })],
    });
    const wait = vi.fn(async () => undefined);
    const result = await pollDeployment(INPUT, f.reference, f.deps, {
      maxPolls: 2,
      intervalMs: 1000,
      wait,
    });
    expect(result.phase).toBe("pending");
    expect(result.outputs).toEqual({});
    expect(f.describeStacks).toHaveBeenCalledTimes(2);
    const invalid = fixture();
    await expect(
      pollDeployment(INPUT, invalid.reference, invalid.deps, {
        maxPolls: 121,
        intervalMs: 1000,
        wait,
      }),
    ).rejects.toThrow("maxPolls");
    await expect(
      pollDeployment(INPUT, invalid.reference, invalid.deps, { maxPolls: 1, intervalMs: 0, wait }),
    ).rejects.toThrow("intervalMs");
    expect(invalid.ssm).not.toHaveBeenCalled();
  });

  it("fails closed on changed references, replacement, missing stacks and unexpected status", async () => {
    const f = fixture();
    await expect(
      describeDeployment(INPUT, { ...f.reference, fingerprint: "other" }, f.deps),
    ).rejects.toThrow("reference");
    expect(f.ssm).not.toHaveBeenCalled();
    await expect(describeDeployment(INPUT, f.reference, f.deps)).rejects.toThrow("missing");
    f.describeStacks.mockResolvedValue({
      Stacks: [f.ownedStack({ StackId: `${f.stackId}-replacement` })],
    });
    await expect(describeDeployment(INPUT, f.reference, f.deps)).rejects.toThrow("replaced");
    for (const StackStatus of ["UPDATE_COMPLETE", "UNKNOWN", undefined]) {
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      await expect(describeDeployment(INPUT, f.reference, f.deps)).rejects.toThrow(
        "Unexpected status",
      );
    }
  });

  it("rejects duplicate or oversized whitelisted outputs", async () => {
    const f = fixture();
    for (const Outputs of [
      [{ OutputKey: "ChallengeUrl", OutputValue: "x".repeat(4097) }],
      [
        { OutputKey: "ChallengeUrl", OutputValue: "a" },
        { OutputKey: "ChallengeUrl", OutputValue: "b" },
      ],
    ]) {
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ Outputs })] });
      await expect(describeDeployment(INPUT, f.reference, f.deps)).rejects.toThrow();
    }
    const many = fixture({ ...INPUT, allowedOutputKeys: ["One", "Two", "Three", "Four", "Five"] });
    many.describeStacks.mockResolvedValue({
      Stacks: [
        many.ownedStack({
          Outputs: many.input.allowedOutputKeys.map((OutputKey) => ({
            OutputKey,
            OutputValue: "a".repeat(4096),
          })),
        }),
      ],
    });
    await expect(describeDeployment(many.input, many.reference, many.deps)).rejects.toThrow(
      "serialized limit",
    );
  });

  it("does not allow caller mutation after the first asynchronous boundary to redirect work", async () => {
    const mutable = structuredClone(INPUT);
    const f = fixture(mutable);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.getParameter.mockImplementation(async () => {
      await gate;
      return {
        Parameter: {
          ARN: INPUT.target.externalIdParameterArn,
          Type: "SecureString",
          Value: EXTERNAL_ID,
        },
      };
    });
    const pending = createDeployment(mutable, f.deps);
    Object.assign(mutable.target, { roleArn: "arn:aws:iam::123456789012:role/Other" });
    Object.assign(mutable, { templateBody: "changed", teamId: "different" });
    release?.();
    await pending;
    expect(f.assumeRole.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ RoleArn: INPUT.target.roleArn }),
    );
    expect(f.createStack.mock.calls[0]?.[0].TemplateBody).toBe(INPUT.templateBody);
  });
});

describe("owned CloudFormation teardown", () => {
  it("durably acknowledges the exact resolved ARN before submitting deletion", async () => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack()] });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onResolved = vi.fn(async (reference: DeploymentReference) => {
      expect(reference).toEqual(f.reference);
      expect(Object.isFrozen(reference)).toBe(true);
      expect(f.describeStacks).toHaveBeenCalledExactlyOnceWith({ StackName: f.identity.stackName });
      expect(f.deleteStack).not.toHaveBeenCalled();
      await gate;
    });
    const pending = deleteDeployment(INPUT, undefined, f.deps, "teardown-a", false, onResolved);
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(f.deleteStack).not.toHaveBeenCalled();
    release?.();
    expect((await pending).reference).toEqual(f.reference);
    expect(f.deleteStack).toHaveBeenCalledTimes(1);
  });

  it.each(["CREATE_COMPLETE", "CREATE_IN_PROGRESS", "DELETE_IN_PROGRESS"])(
    "propagates reference persistence failure in %s without sending DeleteStack",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      const failure = new Error("synthetic durable reference acknowledgement failed");
      const onResolved = vi.fn(async () => {
        throw failure;
      });
      await expect(
        deleteDeployment(INPUT, undefined, f.deps, "teardown-a", false, onResolved),
      ).rejects.toBe(failure);
      expect(onResolved).toHaveBeenCalledExactlyOnceWith(f.reference);
      expect(f.deleteStack).not.toHaveBeenCalled();
    },
  );

  it("deletes the resolved ARN with a deterministic bounded token and no outputs", async () => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack()] });
    const first = await deleteDeployment(INPUT, undefined, f.deps, "teardown-a", false);
    const second = await deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", false);
    expect(first).toEqual({
      reference: f.reference,
      phase: "pending",
      stackStatus: "DELETE_IN_PROGRESS",
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reference)).toBe(true);
    expect(f.describeStacks.mock.calls).toEqual([
      [{ StackName: f.identity.stackName }],
      [{ StackName: f.stackId }],
    ]);
    expect(f.deleteStack.mock.calls[0]).toEqual(f.deleteStack.mock.calls[1]);
    expect(f.deleteStack).toHaveBeenCalledWith({
      StackName: f.stackId,
      ClientRequestToken: expect.stringMatching(/^tc-delete-[a-f0-9]{64}$/),
    });
    expect(f.createStack).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toMatch(
      /Outputs|outputs|AdminPassword|synthetic-secret|synthetic-session/,
    );
  });

  it.each(["CREATE_IN_PROGRESS", "ROLLBACK_IN_PROGRESS"])(
    "waits for %s before attempting deletion",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      expect(await deleteDeployment(INPUT, undefined, f.deps, "teardown-a", false)).toEqual({
        reference: f.reference,
        phase: "waiting",
        stackStatus: StackStatus,
      });
      expect((await describeDeletion(INPUT, f.reference, f.deps, true)).phase).toBe("waiting");
      expect(f.deleteStack).not.toHaveBeenCalled();
    },
  );

  it.each([
    "CREATE_COMPLETE",
    "CREATE_FAILED",
    "ROLLBACK_COMPLETE",
    "ROLLBACK_FAILED",
    "DELETE_FAILED",
  ])("allows an explicit delete request from owned %s", async (StackStatus) => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
    expect((await deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", false)).phase).toBe(
      "pending",
    );
    expect(f.deleteStack).toHaveBeenCalledTimes(1);
  });

  it("converges creation, exposes partial delete failure and supports an explicit fresh retry", async () => {
    const f = fixture();
    const status = (StackStatus: string) => ({ Stacks: [f.ownedStack({ StackStatus })] });
    f.describeStacks
      .mockResolvedValueOnce(status("CREATE_IN_PROGRESS"))
      .mockResolvedValueOnce(status("CREATE_COMPLETE"))
      .mockResolvedValueOnce(status("CREATE_COMPLETE"))
      .mockResolvedValueOnce(status("DELETE_FAILED"))
      .mockResolvedValueOnce(status("DELETE_FAILED"))
      .mockResolvedValueOnce(status("DELETE_IN_PROGRESS"))
      .mockResolvedValueOnce(status("DELETE_COMPLETE"));
    expect((await deleteDeployment(INPUT, undefined, f.deps, "teardown-a", false)).phase).toBe(
      "waiting",
    );
    expect(f.deleteStack).not.toHaveBeenCalled();
    expect((await deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", false)).phase).toBe(
      "pending",
    );
    expect((await describeDeletion(INPUT, f.reference, f.deps, true)).phase).toBe("pending");
    expect(await describeDeletion(INPUT, f.reference, f.deps, true)).toEqual({
      reference: f.reference,
      phase: "failed",
      stackStatus: "DELETE_FAILED",
    });
    expect(f.deleteStack).toHaveBeenCalledTimes(1);
    expect((await deleteDeployment(INPUT, f.reference, f.deps, "teardown-b", false)).phase).toBe(
      "pending",
    );
    expect(f.deleteStack.mock.calls[0]?.[0].ClientRequestToken).not.toBe(
      f.deleteStack.mock.calls[1]?.[0].ClientRequestToken,
    );
    expect((await describeDeletion(INPUT, f.reference, f.deps, true)).phase).toBe("pending");
    expect((await describeDeletion(INPUT, f.reference, f.deps, true)).phase).toBe("deleted");
    expect(f.deleteStack).toHaveBeenCalledTimes(2);
    expect(f.deleteStack.mock.calls.every(([input]) => input.StackName === f.stackId)).toBe(true);
    expect(f.getParameter).toHaveBeenCalledTimes(7);
    expect(f.assumeRole).toHaveBeenCalledTimes(7);
  });

  it.each(["DELETE_IN_PROGRESS", "DELETE_COMPLETE"])(
    "handles duplicate submission in %s without another delete",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      const expected = StackStatus === "DELETE_COMPLETE" ? "deleted" : "pending";
      expect((await deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", false)).phase).toBe(
        expected,
      );
      expect((await describeDeletion(INPUT, f.reference, f.deps, true)).phase).toBe(expected);
      expect(f.deleteStack).not.toHaveBeenCalled();
    },
  );

  it.each([
    "EventId",
    "TeamId",
    "ProblemId",
    "JobId",
    "AttemptId",
    "AccountId",
    "Region",
    "RequestFingerprint",
  ])(
    "rejects mismatched, missing or duplicate %s ownership tags on delete and poll",
    async (field) => {
      for (const change of ["mismatch", "missing", "duplicate"]) {
        const f = fixture();
        const key = `TenkaCloud:${field}`;
        const tags = deploymentOwnershipTags(f.input);
        let Tags: StackDescription["Tags"];
        if (change === "missing") Tags = tags.filter((tag) => tag.Key !== key);
        else if (change === "duplicate") Tags = [...tags, ...tags.filter((tag) => tag.Key === key)];
        else Tags = tags.map((tag) => (tag.Key === key ? { ...tag, Value: "other" } : tag));
        f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ Tags })] });
        await expect(
          deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true),
        ).rejects.toThrow("ownership");
        await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow(
          "ownership",
        );
        expect(f.deleteStack).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { eventId: "event-b" },
    { teamId: "team-b" },
    { problemId: "problem-b" },
    { jobId: "job-b" },
    { attemptId: "attempt-b" },
    { templateBody: "changed" },
    { parameters: [{ key: "NamePrefix", value: "changed" }] },
    { capabilities: ["CAPABILITY_IAM"] },
    { allowedOutputKeys: ["OtherOutput"] },
    { target: { ...INPUT.target, roleArn: "arn:aws:iam::123456789012:role/Other" } },
    {
      target: {
        ...INPUT.target,
        externalIdParameterArn: `${INPUT.target.externalIdParameterArn}-other`,
      },
    },
    {
      target: {
        ...INPUT.target,
        accountId: "111111111111",
        roleArn: "arn:aws:iam::111111111111:role/TenkaCloudDeploy",
      },
    },
    { target: { ...INPUT.target, region: "us-west-2" } },
  ])("rejects changed immutable input before acquiring credentials: %j", async (change) => {
    const f = fixture();
    await expect(
      deleteDeployment({ ...INPUT, ...change }, f.reference, f.deps, "teardown-a", true),
    ).rejects.toThrow();
    await expect(
      describeDeletion({ ...INPUT, ...change }, f.reference, f.deps, true),
    ).rejects.toThrow();
    expect(f.ssm).not.toHaveBeenCalled();
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });

  it("rejects a substituted ARN or name even when all ownership tags match", async () => {
    for (const change of [
      { StackId: fixture().stackId.replace("123456789012", "111111111111") },
      { StackId: fixture().stackId.replace("us-east-1", "us-west-2") },
      { StackId: fixture().stackId.replace("stack/tc-", "stack/other-") },
      { StackId: `${fixture().stackId}-replacement` },
      { StackName: "another-stack" },
    ]) {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack(change)] });
      await expect(
        deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true),
      ).rejects.toThrow();
      await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow();
      expect(f.describeStacks.mock.calls.every(([input]) => input.StackName === f.stackId)).toBe(
        true,
      );
      expect(f.deleteStack).not.toHaveBeenCalled();
    }
  });

  it("requires explicit permission for exact absence and keeps uncertain creation fail-closed", async () => {
    const f = fixture();
    for (const reference of [undefined, f.reference]) {
      await expect(deleteDeployment(INPUT, reference, f.deps, "teardown-a", false)).rejects.toThrow(
        "absence is not confirmed",
      );
      const result = await deleteDeployment(INPUT, reference, f.deps, "teardown-a", true);
      expect(result).toEqual({
        ...(reference ? { reference } : {}),
        phase: "deleted",
        stackStatus: "DELETE_COMPLETE",
      });
    }
    await expect(describeDeletion(INPUT, f.reference, f.deps, false)).rejects.toThrow(
      "absence is not confirmed",
    );
    expect(await describeDeletion(INPUT, f.reference, f.deps, true)).toEqual({
      reference: f.reference,
      phase: "deleted",
      stackStatus: "DELETE_COMPLETE",
    });
    expect(f.deleteStack).not.toHaveBeenCalled();
  });

  it("never mistakes access denial, generic validation, unrelated absence or malformed responses for deletion", async () => {
    const f = fixture();
    for (const error of [
      namedError("AccessDenied", `Stack with id ${f.stackId} does not exist`),
      namedError("ValidationError", "Validation failed"),
      namedError("ValidationError", `Stack with id ${f.identity.stackName} does not exist`),
      namedError("ValidationError", `Stack with id ${f.stackId} does not exist; try again`),
      namedError("ThrottlingException", "slow down"),
      { name: "ValidationError", message: `Stack with id ${f.stackId} does not exist` },
    ]) {
      f.describeStacks.mockRejectedValue(error);
      await expect(deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true)).rejects.toBe(
        error,
      );
      await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toBe(error);
    }
    for (const response of [
      {},
      { Stacks: [] },
      { Stacks: new Array<StackDescription>(1) },
      { Stacks: [f.ownedStack(), f.ownedStack()] },
    ]) {
      f.describeStacks.mockResolvedValue(response);
      await expect(
        deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true),
      ).rejects.toThrow("ambiguous");
      await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow("ambiguous");
    }
    expect(f.deleteStack).not.toHaveBeenCalled();
  });

  it.each(["UPDATE_IN_PROGRESS", "UPDATE_COMPLETE", "IMPORT_COMPLETE", "UNKNOWN", undefined])(
    "rejects unrecognized status %s without sending a delete",
    async (StackStatus) => {
      const f = fixture();
      f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack({ StackStatus })] });
      await expect(
        deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true),
      ).rejects.toThrow("Unexpected status");
      await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow(
        "Unexpected status",
      );
      expect(f.deleteStack).not.toHaveBeenCalled();
    },
  );

  it.each(["", "x".repeat(129), "with space", "invalid/token"])(
    "rejects invalid teardown token %j before credentials",
    async (token) => {
      const f = fixture();
      await expect(deleteDeployment(INPUT, f.reference, f.deps, token, true)).rejects.toThrow(
        "request token",
      );
      expect(f.ssm).not.toHaveBeenCalled();
    },
  );

  it("refreshes the current ExternalId and target credentials on every delete and poll", async () => {
    const f = fixture();
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack()] });
    await deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", false);
    f.getParameter.mockResolvedValue({
      Parameter: {
        ARN: INPUT.target.externalIdParameterArn,
        Type: "SecureString",
        Value: "rotated-external-id",
      },
    });
    f.assumeRole.mockResolvedValue({
      Credentials: {
        AccessKeyId: "ROTATED_ACCESS_KEY",
        SecretAccessKey: "rotated-secret",
        SessionToken: "rotated-session",
        Expiration: new Date(NOW + 900_000),
      },
    });
    await describeDeletion(INPUT, f.reference, f.deps, true);
    expect(f.getParameter).toHaveBeenCalledTimes(2);
    expect(f.assumeRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ RoleArn: INPUT.target.roleArn, ExternalId: "rotated-external-id" }),
    );
    expect(f.cloudFormation).toHaveBeenLastCalledWith({
      region: INPUT.target.region,
      accountId: INPUT.target.accountId,
      credentials: {
        accessKeyId: "ROTATED_ACCESS_KEY",
        secretAccessKey: "rotated-secret",
        sessionToken: "rotated-session",
        expiration: new Date(NOW + 900_000),
      },
    });
  });

  it.each([
    { Type: "String" },
    { Value: "" },
    { Value: "with spaces" },
    { ARN: `${INPUT.target.externalIdParameterArn}-other` },
  ])("requires the matching current SecureString on delete and poll: %j", async (change) => {
    const f = fixture();
    f.getParameter.mockResolvedValue({
      Parameter: {
        ARN: INPUT.target.externalIdParameterArn,
        Type: "SecureString",
        Value: EXTERNAL_ID,
        ...change,
      },
    });
    await expect(deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true)).rejects.toThrow(
      "SecureString ExternalId",
    );
    await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow(
      "SecureString ExternalId",
    );
    expect(f.assumeRole).not.toHaveBeenCalled();
    expect(f.cloudFormation).not.toHaveBeenCalled();
  });

  it.each([
    { AccessKeyId: "" },
    { SecretAccessKey: "" },
    { SessionToken: "" },
    { Expiration: new Date(NOW) },
    { Expiration: new Date(NOW + 60_000) },
    { Expiration: new Date(Number.NaN) },
  ])(
    "rejects incomplete or expiring delete/poll credentials without ambient fallback: %j",
    async (change) => {
      const f = fixture();
      f.assumeRole.mockResolvedValue({
        Credentials: {
          AccessKeyId: "synthetic",
          SecretAccessKey: "synthetic",
          SessionToken: "synthetic",
          Expiration: new Date(NOW + 900_000),
          ...change,
        },
      });
      await expect(
        deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true),
      ).rejects.toThrow("incomplete or expired");
      await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toThrow(
        "incomplete or expired",
      );
      expect(f.cloudFormation).not.toHaveBeenCalled();
    },
  );

  it("propagates current authorization failure and all delete submission failures", async () => {
    const denied = namedError("AccessDenied", "synthetic denied");
    const f = fixture();
    f.assumeRole.mockRejectedValue(denied);
    await expect(deleteDeployment(INPUT, f.reference, f.deps, "teardown-a", true)).rejects.toBe(
      denied,
    );
    await expect(describeDeletion(INPUT, f.reference, f.deps, true)).rejects.toBe(denied);
    expect(f.cloudFormation).not.toHaveBeenCalled();
    const submitting = fixture();
    submitting.describeStacks.mockResolvedValue({ Stacks: [submitting.ownedStack()] });
    for (const error of [
      denied,
      namedError("ValidationError", `Stack with id ${submitting.stackId} does not exist`),
    ]) {
      submitting.deleteStack.mockRejectedValue(error);
      await expect(
        deleteDeployment(INPUT, submitting.reference, submitting.deps, "teardown-a", true),
      ).rejects.toBe(error);
    }
  });

  it("snapshots caller input and physical reference before asynchronous work", async () => {
    const mutable = structuredClone(INPUT);
    const f = fixture(mutable);
    const reference = { ...f.reference };
    f.describeStacks.mockResolvedValue({ Stacks: [f.ownedStack()] });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.getParameter.mockImplementation(async () => {
      await gate;
      return {
        Parameter: {
          ARN: INPUT.target.externalIdParameterArn,
          Type: "SecureString",
          Value: EXTERNAL_ID,
        },
      };
    });
    const pending = deleteDeployment(mutable, reference, f.deps, "teardown-a", false);
    Object.assign(mutable, { teamId: "other" });
    Object.assign(mutable.target, { roleArn: "arn:aws:iam::123456789012:role/Other" });
    reference.stackId = `${f.stackId}-replacement`;
    reference.fingerprint = "other";
    release?.();
    expect((await pending).reference).toEqual(f.reference);
    expect(f.describeStacks).toHaveBeenCalledExactlyOnceWith({ StackName: f.stackId });
    expect(f.deleteStack.mock.calls[0]?.[0].StackName).toBe(f.stackId);
    expect(f.assumeRole.mock.calls[0]?.[0].RoleArn).toBe(INPUT.target.roleArn);
  });
});

describe("real SDK adapter with all AWS send methods intercepted", () => {
  it("constructs explicit commands and regions without resolving credentials or making network requests", async () => {
    const f = fixture();
    const ssmSend = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async () => ({
      $metadata: {},
      Parameter: {
        ARN: INPUT.target.externalIdParameterArn,
        Type: "SecureString",
        Value: EXTERNAL_ID,
      },
    }));
    const stsSend = vi.spyOn(STSClient.prototype, "send").mockImplementation(async () => ({
      $metadata: {},
      Credentials: {
        AccessKeyId: "SYNTHETIC_ACCESS_KEY",
        SecretAccessKey: "synthetic-secret",
        SessionToken: "synthetic-session",
        Expiration: new Date(NOW + 900_000),
      },
    }));
    const cfnSend = vi
      .spyOn(CloudFormationClient.prototype, "send")
      .mockImplementation(async (command) => {
        if (command instanceof DescribeStacksCommand) {
          throw namedError(
            "ValidationError",
            `Stack with id ${f.identity.stackName} does not exist`,
          );
        }
        return { $metadata: {}, StackId: f.stackId };
      });
    const deps = {
      ...createAwsCloudRunnerDependencies({ controlPlaneRegion: "us-west-2" }),
      now: () => NOW,
    };
    expect((await createDeployment(INPUT, deps)).reference).toEqual(f.reference);
    expect(ssmSend.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
    expect(stsSend.mock.calls[0]?.[0]).toBeInstanceOf(AssumeRoleCommand);
    expect(cfnSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStacksCommand);
    expect(cfnSend.mock.calls[1]?.[0]).toBeInstanceOf(CreateStackCommand);
    cfnSend.mockImplementation(async (command) => {
      if (command instanceof DescribeStacksCommand) return { Stacks: [f.ownedStack()] };
      if (command instanceof DeleteStackCommand) return { $metadata: {} };
      throw new Error("Unexpected SDK command during teardown");
    });
    expect((await deleteDeployment(INPUT, f.reference, deps, "teardown-a", false)).phase).toBe(
      "pending",
    );
    expect(cfnSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeStacksCommand);
    expect(cfnSend.mock.calls[3]?.[0]).toBeInstanceOf(DeleteStackCommand);
    expect(cfnSend.mock.calls[3]?.[0].input).toEqual({
      StackName: f.stackId,
      ClientRequestToken: expect.stringMatching(/^tc-delete-[a-f0-9]{64}$/),
    });
    expect(ssmSend).toHaveBeenCalledTimes(2);
    expect(stsSend).toHaveBeenCalledTimes(2);
    const ssm = ssmSend.mock.contexts[0];
    const sts = stsSend.mock.contexts[0];
    const cfn = cfnSend.mock.contexts[0];
    if (
      !(ssm instanceof SSMClient) ||
      !(sts instanceof STSClient) ||
      !(cfn instanceof CloudFormationClient)
    ) {
      throw new Error("SDK client construction was not intercepted");
    }
    expect(await ssm.config.region()).toBe("us-west-2");
    expect(await sts.config.region()).toBe("us-west-2");
    expect(await cfn.config.region()).toBe("us-east-1");
    for (const client of [ssm, sts, cfn])
      expect(client.config.ignoreConfiguredEndpointUrls).toBe(true);
    expect(await cfn.config.credentials()).toEqual(
      expect.objectContaining({
        accessKeyId: "SYNTHETIC_ACCESS_KEY",
        secretAccessKey: "synthetic-secret",
        sessionToken: "synthetic-session",
        accountId: "123456789012",
      }),
    );
  });

  it("rejects region, account and credential omissions rather than using ambient target credentials", () => {
    expect(() => createAwsCloudRunnerDependencies({ controlPlaneRegion: "" })).toThrow(
      "commercial AWS regions",
    );
    const deps = createAwsCloudRunnerDependencies({ controlPlaneRegion: "us-east-1" });
    expect(() => deps.ssm("https://untrusted.example.test")).toThrow("commercial AWS regions");
    const credentials = {
      accessKeyId: "synthetic",
      secretAccessKey: "synthetic",
      sessionToken: "synthetic",
      expiration: new Date(NOW + 900_000),
    };
    expect(() => deps.cloudFormation({ region: "us-east-1", accountId: "", credentials })).toThrow(
      "explicit AWS account",
    );
    expect(() =>
      deps.cloudFormation({ region: "", accountId: "123456789012", credentials }),
    ).toThrow("commercial AWS regions");
    expect(() =>
      deps.cloudFormation({
        region: "us-east-1",
        accountId: "123456789012",
        credentials: { ...credentials, sessionToken: "" },
      }),
    ).toThrow("assumed-role credentials");
  });

  it.each(UNSUPPORTED_REGIONS)(
    "rejects direct SDK adapter configuration in unsupported region %s",
    (region) => {
      expect(() => createAwsCloudRunnerDependencies({ controlPlaneRegion: region })).toThrow(
        "commercial AWS regions",
      );
      const deps = createAwsCloudRunnerDependencies({ controlPlaneRegion: "us-east-1" });
      expect(() => deps.ssm(region)).toThrow("commercial AWS regions");
      expect(() =>
        deps.cloudFormation({
          region,
          accountId: INPUT.target.accountId,
          credentials: {
            accessKeyId: "synthetic",
            secretAccessKey: "synthetic",
            sessionToken: "synthetic",
            expiration: new Date(NOW + 900_000),
          },
        }),
      ).toThrow("commercial AWS regions");
    },
  );
});
