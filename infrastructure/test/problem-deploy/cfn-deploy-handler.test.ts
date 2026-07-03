import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import type { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildArtifactsResolver,
  buildParameterOverrides,
  buildS3ArtifactsResolver,
  buildStackTags,
  classifyDeployAction,
  createStackForDeployment,
  type DeployArtifacts,
  generateRandomAlphanumeric,
  isNoUpdatesError,
  isStackNotFoundError,
  isUnrecoverableStackStatus,
  parseCfnParameters,
  RANDOM_PASSWORD_TOKEN,
} from "../../lib/problem-deploy/handlers/cfn-deploy-handler/create-stack.js";

/**
 * Issue #2291 (ADR-049 §9): Lambda CreateStack deploy handler unit tests.
 *
 * All AWS SDK clients are mocked via injected `send` fakes (no network). The tests lock the
 * behavior ported from `scripts/deploy-battles.sh`: parameter overrides (incl.
 * `__RANDOM_PASSWORD__`), ExternalId resolution + cross-account AssumeRole, the CreateStack call
 * shape, and the unrecoverable-stack pre-delete decision.
 */

const VALID_JOB_ID = "01HX0000000000000000000ABC"; // >= 16 chars (ULID-shaped)

function validDetail(overrides: Record<string, unknown> = {}) {
  return {
    jobId: VALID_JOB_ID,
    tenantId: "tenant-acme",
    problemId: "sample-flag",
    problemDir: "problems/challenges/sample-flag",
    teamSlug: "demo-team",
    namePrefix: "tc-sample-flag-demo-team",
    region: "ap-northeast-1",
    awsAccountId: "123456789012",
    competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeployRole",
    externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    ...overrides,
  };
}

const artifacts: DeployArtifacts = {
  templateBody: "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n",
  cfnParameters: { FlagSeed: RANDOM_PASSWORD_TOKEN },
};

interface FakeCfnState {
  readonly describeResponses: Array<{ status?: string; notFound?: boolean; throw?: string }>;
  readonly commands: unknown[];
  /** When set, UpdateStack rejects with this message (e.g. "No updates are to be performed."). */
  updateThrows?: string;
  /** When true, UpdateStack resolves without a StackId (covers the `?? "-"` fallback line). */
  updateNoStackId?: boolean;
}

const UPDATE_STACK_ID = "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/updated";
const CREATE_STACK_ID = "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1";

function scriptedDescribe(scripted: FakeCfnState["describeResponses"][number]) {
  if (scripted.notFound) throw new Error("Stack with id tc-sample-flag-demo-team does not exist");
  if (scripted.throw) throw new Error(scripted.throw);
  return { Stacks: [{ StackStatus: scripted.status, StackId: "arn:stack/id" }] };
}

/** A fake CloudFormation client whose DescribeStacks responses are scripted per call. */
function fakeCfn(state: FakeCfnState) {
  let describeIndex = 0;
  return {
    send: vi.fn(async (command: unknown) => {
      state.commands.push(command);
      if (command instanceof DescribeStacksCommand) {
        return scriptedDescribe(state.describeResponses[describeIndex++] ?? {});
      }
      if (command instanceof DeleteStackCommand) return {};
      if (command instanceof UpdateStackCommand) {
        if (state.updateThrows) throw new Error(state.updateThrows);
        return state.updateNoStackId ? {} : { StackId: UPDATE_STACK_ID };
      }
      if (command instanceof CreateStackCommand) return { StackId: CREATE_STACK_ID };
      throw new Error(`unexpected command: ${(command as object).constructor.name}`);
    }),
  };
}

function crossAccountDeps(cfn: ReturnType<typeof fakeCfn>) {
  const ssmSend = vi.fn(async () => ({
    Parameter: { Value: "external-id-secret-value", Version: 3 },
  }));
  const stsSend = vi.fn(async () => ({
    Credentials: {
      AccessKeyId: "AKIA_TEST",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(),
    },
  }));
  return {
    ssm: { send: ssmSend },
    sts: { send: stsSend },
    cfnClient: vi.fn(() => cfn),
    resolveArtifacts: vi.fn(async () => artifacts),
    tenkaCloudAccountId: "999988887777",
    cfnExecRoleArn: "arn:aws:iam::999988887777:role/CfnExec",
    generateToken: () => "GENERATED_TOKEN_0000000000000000",
    waitForStackDelete: vi.fn(async () => {}),
    _ssmSend: ssmSend,
    _stsSend: stsSend,
  };
}

describe("buildParameterOverrides (#2291)", () => {
  it("should always inject NamePrefix, TenkaCloudAccountId and ExternalId first", () => {
    const params = buildParameterOverrides({
      cfnParameters: {},
      namePrefix: "tc-x-y",
      tenkaCloudAccountId: "111122223333",
      externalId: VALID_JOB_ID,
      generateToken: () => "TOK",
    });
    expect(params.slice(0, 3)).toEqual([
      { ParameterKey: "NamePrefix", ParameterValue: "tc-x-y" },
      { ParameterKey: "TenkaCloudAccountId", ParameterValue: "111122223333" },
      { ParameterKey: "ExternalId", ParameterValue: VALID_JOB_ID },
    ]);
  });

  it("should replace __RANDOM_PASSWORD__ with a generated secret and pass others through", () => {
    const params = buildParameterOverrides({
      cfnParameters: { DbPassword: RANDOM_PASSWORD_TOKEN, Fixed: "keep-me" },
      namePrefix: "tc-x-y",
      tenkaCloudAccountId: "111122223333",
      externalId: VALID_JOB_ID,
      generateToken: () => "RANDOM_SECRET_VALUE",
    });
    expect(params).toContainEqual({
      ParameterKey: "DbPassword",
      ParameterValue: "RANDOM_SECRET_VALUE",
    });
    expect(params).toContainEqual({ ParameterKey: "Fixed", ParameterValue: "keep-me" });
  });

  it("should reject an ExternalId shorter than 16 chars (competitor-bootstrap MinLength)", () => {
    expect(() =>
      buildParameterOverrides({
        cfnParameters: {},
        namePrefix: "tc-x-y",
        tenkaCloudAccountId: "111122223333",
        externalId: "short",
        generateToken: () => "TOK",
      }),
    ).toThrow(/at least 16 characters/);
  });

  it("should skip empty parameter keys", () => {
    const params = buildParameterOverrides({
      cfnParameters: { "": "dropped", Keep: "kept" },
      namePrefix: "tc-x-y",
      tenkaCloudAccountId: "111122223333",
      externalId: VALID_JOB_ID,
      generateToken: () => "TOK",
    });
    expect(params.some((p) => p.ParameterKey === "")).toBe(false);
    expect(params).toContainEqual({ ParameterKey: "Keep", ParameterValue: "kept" });
  });
});

describe("generateRandomAlphanumeric (#2291)", () => {
  it("should produce a 32-char alphanumeric string by default", () => {
    const value = generateRandomAlphanumeric();
    expect(value).toHaveLength(32);
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});

describe("buildStackTags (#2291)", () => {
  it("should preserve the TenkaCloud:* tag keys and default BatchId to JobId", () => {
    const tags = buildStackTags({
      namePrefix: "tc-sample-flag-demo-team",
      problemSlug: "sample-flag",
      teamSlug: "demo-team",
      tenantId: "tenant-acme",
      jobId: VALID_JOB_ID,
    });
    const byKey = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(byKey["TenkaCloud:NamePrefix"]).toBe("tc-sample-flag-demo-team");
    expect(byKey["TenkaCloud:Problem"]).toBe("sample-flag");
    expect(byKey["TenkaCloud:ProblemId"]).toBe("sample-flag");
    expect(byKey["TenkaCloud:TeamSlug"]).toBe("demo-team");
    expect(byKey["TenkaCloud:TenantId"]).toBe("tenant-acme");
    expect(byKey["TenkaCloud:JobId"]).toBe(VALID_JOB_ID);
    expect(byKey["TenkaCloud:BatchId"]).toBe(VALID_JOB_ID);
    expect(byKey["TenkaCloud:DeployedBy"]).toBe("cfn-deploy-lambda");
  });
});

describe("isUnrecoverableStackStatus (#2291)", () => {
  it("should flag the un-updatable states that require a pre-delete", () => {
    for (const s of [
      "ROLLBACK_COMPLETE",
      "ROLLBACK_FAILED",
      "CREATE_FAILED",
      "DELETE_FAILED",
      "REVIEW_IN_PROGRESS",
    ]) {
      expect(isUnrecoverableStackStatus(s)).toBe(true);
    }
  });
  it("should leave healthy / absent states alone", () => {
    expect(isUnrecoverableStackStatus("CREATE_COMPLETE")).toBe(false);
    expect(isUnrecoverableStackStatus("UPDATE_COMPLETE")).toBe(false);
    expect(isUnrecoverableStackStatus(undefined)).toBe(false);
  });
});

describe("isStackNotFoundError / parseCfnParameters (#2291)", () => {
  it("should detect the CloudFormation 'does not exist' error", () => {
    expect(isStackNotFoundError(new Error("Stack with id tc-x does not exist"))).toBe(true);
    expect(isStackNotFoundError(new Error("Throttling"))).toBe(false);
    expect(isStackNotFoundError("not-an-error")).toBe(false);
  });

  it("should read string cfnParameters and default to empty when absent", () => {
    expect(parseCfnParameters(JSON.stringify({ cfnParameters: { A: "1" } }))).toEqual({ A: "1" });
    expect(parseCfnParameters(JSON.stringify({ id: "x" }))).toEqual({});
  });

  it("should throw loudly on non-string cfnParameters values (fail loud, no silent drop)", () => {
    expect(() => parseCfnParameters(JSON.stringify({ cfnParameters: { A: 1 } }))).toThrow(/string/);
    expect(() => parseCfnParameters("not json")).toThrow(/valid JSON/);
  });

  it("should throw when cfnParameters is null or an array (must be an object)", () => {
    expect(() => parseCfnParameters(JSON.stringify({ cfnParameters: null }))).toThrow(
      /must be an object/,
    );
    expect(() => parseCfnParameters(JSON.stringify({ cfnParameters: [] }))).toThrow(
      /must be an object/,
    );
  });
});

describe("classifyDeployAction (#2291)", () => {
  it("should classify an absent stack (undefined) as a create", () => {
    expect(classifyDeployAction(undefined)).toBe("create");
  });

  it("should classify unrecoverable states as delete-recreate", () => {
    for (const s of [
      "ROLLBACK_COMPLETE",
      "ROLLBACK_FAILED",
      "CREATE_FAILED",
      "DELETE_FAILED",
      "REVIEW_IN_PROGRESS",
    ]) {
      expect(classifyDeployAction(s)).toBe("delete-recreate");
    }
  });

  it("should classify healthy states as an in-place update", () => {
    for (const s of [
      "CREATE_COMPLETE",
      "UPDATE_COMPLETE",
      "UPDATE_ROLLBACK_COMPLETE",
      "IMPORT_COMPLETE",
      "IMPORT_ROLLBACK_COMPLETE",
    ]) {
      expect(classifyDeployAction(s)).toBe("update");
    }
  });

  it("should classify transitional *_IN_PROGRESS states as in-progress", () => {
    for (const s of [
      "CREATE_IN_PROGRESS",
      "UPDATE_IN_PROGRESS",
      "DELETE_IN_PROGRESS",
      "UPDATE_ROLLBACK_IN_PROGRESS",
    ]) {
      expect(classifyDeployAction(s)).toBe("in-progress");
    }
  });
});

describe("isNoUpdatesError (#2291)", () => {
  it("should match the CloudFormation 'No updates are to be performed' message", () => {
    expect(isNoUpdatesError(new Error("No updates are to be performed."))).toBe(true);
    // Case-insensitive (the SDK wraps the message in various shapes).
    expect(isNoUpdatesError(new Error("ValidationError: no updates are to be performed"))).toBe(
      true,
    );
  });

  it("should not match other errors or non-Error values", () => {
    expect(isNoUpdatesError(new Error("AlreadyExistsException"))).toBe(false);
    expect(isNoUpdatesError("no updates are to be performed")).toBe(false);
    expect(isNoUpdatesError(undefined)).toBe(false);
  });
});

describe("buildS3ArtifactsResolver (#2291)", () => {
  it("should read template.yaml + metadata.json cfnParameters from the source bucket", async () => {
    const bodies: Record<string, string> = {
      "problems/challenges/sample-flag/template.yaml":
        "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n",
      "problems/challenges/sample-flag/metadata.json": JSON.stringify({
        cfnParameters: { FlagSeed: "seed-value" },
      }),
    };
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        const key = (command as GetObjectCommand).input.Key as string;
        return { Body: { transformToString: async () => bodies[key] } };
      }),
    };
    const resolve = buildS3ArtifactsResolver(s3 as unknown as Pick<S3Client, "send">, {
      sourceBucket: "src-bucket",
    });
    const out = await resolve(validDetail() as never);

    expect(out.templateBody).toContain("AWSTemplateFormatVersion");
    expect(out.cfnParameters).toEqual({ FlagSeed: "seed-value" });
    expect((s3.send.mock.calls[0]?.[0] as GetObjectCommand).input).toMatchObject({
      Bucket: "src-bucket",
      Key: "problems/challenges/sample-flag/template.yaml",
    });
  });

  it("should throw loudly on an empty / unreadable S3 object body (fail loud)", async () => {
    const s3 = { send: vi.fn(async () => ({ Body: undefined })) };
    const resolve = buildS3ArtifactsResolver(s3 as unknown as Pick<S3Client, "send">, {
      sourceBucket: "src-bucket",
    });
    await expect(resolve(validDetail() as never)).rejects.toThrow(/empty or unreadable S3 object/);
  });
});

describe("buildArtifactsResolver (#2291)", () => {
  it("should resolve artifacts from the challenge payload when challengePayloadUrl is set", async () => {
    const resolveFromS3 = vi.fn(async () => artifacts);
    const fetchPayloadArtifacts = vi.fn(async () => ({
      templateBody: "AWSTemplateFormatVersion: '2010-09-09'\nResources: {Payload: {}}\n",
      metadataText: JSON.stringify({ cfnParameters: { FlagSeed: "from-payload" } }),
    }));
    const resolve = buildArtifactsResolver({ resolveFromS3, fetchPayloadArtifacts });

    const out = await resolve(
      validDetail({ challengePayloadUrl: "https://s3.example/presigned?sig=x" }) as never,
    );

    // Private path: fetched the presigned payload, parsed its metadata; never touched S3.
    expect(fetchPayloadArtifacts).toHaveBeenCalledWith("https://s3.example/presigned?sig=x");
    expect(resolveFromS3).not.toHaveBeenCalled();
    expect(out.templateBody).toContain("Payload");
    expect(out.cfnParameters).toEqual({ FlagSeed: "from-payload" });
  });

  it("should resolve from the source bucket when challengePayloadUrl is absent (public path unchanged)", async () => {
    const resolveFromS3 = vi.fn(async () => artifacts);
    const fetchPayloadArtifacts = vi.fn(async () => {
      throw new Error("must not fetch a payload for a public problem");
    });
    const resolve = buildArtifactsResolver({ resolveFromS3, fetchPayloadArtifacts });

    const out = await resolve(validDetail() as never);

    expect(resolveFromS3).toHaveBeenCalledOnce();
    expect(fetchPayloadArtifacts).not.toHaveBeenCalled();
    expect(out).toBe(artifacts);
  });

  it("should treat an empty-string challengePayloadUrl as public (source bucket)", async () => {
    // Zod allows only a valid URL or undefined, but the resolver guards on non-empty defensively.
    const resolveFromS3 = vi.fn(async () => artifacts);
    const fetchPayloadArtifacts = vi.fn(async () => ({ templateBody: "x", metadataText: "{}" }));
    const resolve = buildArtifactsResolver({ resolveFromS3, fetchPayloadArtifacts });

    await resolve({ ...validDetail(), challengePayloadUrl: "" } as never);

    expect(resolveFromS3).toHaveBeenCalledOnce();
    expect(fetchPayloadArtifacts).not.toHaveBeenCalled();
  });

  it("should default to the real payload fetcher when none is injected (public path still works offline)", async () => {
    // No fetchPayloadArtifacts injected → defaults to the real module fn; the public path does not
    // reach it, so this resolves from S3 without any network.
    const resolveFromS3 = vi.fn(async () => artifacts);
    const resolve = buildArtifactsResolver({ resolveFromS3 });
    const out = await resolve(validDetail() as never);
    expect(out).toBe(artifacts);
    expect(resolveFromS3).toHaveBeenCalledOnce();
  });
});

describe("createStackForDeployment cross-account (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should resolve the ExternalId from SSM and AssumeRole before CreateStack", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment({ detail: validDetail() }, deps);

    // ExternalId read from SSM SecureString (WithDecryption).
    const getParam = deps._ssmSend.mock.calls[0][0];
    expect(getParam).toBeInstanceOf(GetParameterCommand);
    expect(getParam.input).toMatchObject({
      Name: "/development/tenants/tenant-acme/external-id",
      WithDecryption: true,
    });
    // AssumeRole always carries the ExternalId (never omitted).
    const assume = deps._stsSend.mock.calls[0][0];
    expect(assume).toBeInstanceOf(AssumeRoleCommand);
    expect(assume.input).toMatchObject({
      RoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeployRole",
      ExternalId: "external-id-secret-value",
    });
  });

  it("should CreateStack with the correct shape (template, params, capabilities, tags, no RoleARN cross-account)", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);

    expect(result.stackId).toBe("arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1");
    const createCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof CreateStackCommand);
    expect(createCmd).toBeInstanceOf(CreateStackCommand);
    const input = (createCmd as CreateStackCommand).input;
    expect(input.StackName).toBe("tc-sample-flag-demo-team");
    expect(input.TemplateBody).toBe(artifacts.templateBody);
    expect(input.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    // Cross-account uses assumed creds → no platform RoleARN passed.
    expect(input.RoleARN).toBeUndefined();
    // Injected params + generated __RANDOM_PASSWORD__.
    expect(input.Parameters).toContainEqual({
      ParameterKey: "NamePrefix",
      ParameterValue: "tc-sample-flag-demo-team",
    });
    expect(input.Parameters).toContainEqual({
      ParameterKey: "TenkaCloudAccountId",
      ParameterValue: "999988887777",
    });
    expect(input.Parameters).toContainEqual({
      ParameterKey: "ExternalId",
      ParameterValue: VALID_JOB_ID,
    });
    expect(input.Parameters).toContainEqual({
      ParameterKey: "FlagSeed",
      ParameterValue: "GENERATED_TOKEN_0000000000000000",
    });
    // CFn client built for the competitor region + assumed credentials.
    expect(deps.cfnClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "ap-northeast-1",
        credentials: expect.objectContaining({ AccessKeyId: "AKIA_TEST" }),
      }),
    );
  });

  it("should delete an unrecoverable stack before re-create, then CreateStack", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "ROLLBACK_COMPLETE" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment({ detail: validDetail() }, deps);

    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).toContain("DescribeStacksCommand");
    expect(kinds).toContain("DeleteStackCommand");
    expect(kinds).toContain("CreateStackCommand");
    // DeleteStack precedes CreateStack.
    expect(kinds.indexOf("DeleteStackCommand")).toBeLessThan(kinds.indexOf("CreateStackCommand"));
    expect(deps.waitForStackDelete).toHaveBeenCalledOnce();
  });

  it("should NOT delete when the stack is absent (plain create)", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment({ detail: validDetail() }, deps);

    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).not.toContain("DeleteStackCommand");
    expect(deps.waitForStackDelete).not.toHaveBeenCalled();
  });

  it("should reject an invalid event detail (schema fail-loud)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(
      createStackForDeployment(
        { detail: validDetail({ namePrefix: "not-a-valid-prefix!" }) },
        deps,
      ),
    ).rejects.toThrow();
  });

  it("should fall back to the built-in random token generator when none is injected", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = { ...crossAccountDeps(cfn), generateToken: undefined };
    await createStackForDeployment({ detail: validDetail() }, deps);

    const createCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof CreateStackCommand);
    const flagSeed = (createCmd as CreateStackCommand).input.Parameters?.find(
      (p) => p.ParameterKey === "FlagSeed",
    );
    // __RANDOM_PASSWORD__ resolved to a fresh 32-char alphanumeric secret via the default generator.
    expect(flagSeed?.ParameterValue).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("should drain a real DescribeStacks poll before re-create when no waiter is injected", async () => {
    // Exercises the built-in defaultWaitForStackDelete: describe (classify → unrecoverable) → delete
    // → describe (drain, now gone) → create.
    const cfn = fakeCfn({
      describeResponses: [{ status: "ROLLBACK_COMPLETE" }, { notFound: true }],
      commands: [],
    });
    const deps = { ...crossAccountDeps(cfn), waitForStackDelete: undefined };
    const result = await createStackForDeployment({ detail: validDetail() }, deps);

    expect(result.stackId).toBe("arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1");
    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds.filter((k) => k === "DescribeStacksCommand")).toHaveLength(2);
    expect(kinds.indexOf("DeleteStackCommand")).toBeLessThan(kinds.indexOf("CreateStackCommand"));
  });

  it("should fail loud when the pre-create delete drain hits DELETE_FAILED", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "ROLLBACK_COMPLETE" }, { status: "DELETE_FAILED" }],
      commands: [],
    });
    const deps = { ...crossAccountDeps(cfn), waitForStackDelete: undefined };
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /could not be deleted \(DELETE_FAILED\)/,
    );
    // Never reached CreateStack.
    expect(cfn.send.mock.calls.some((c) => c[0] instanceof CreateStackCommand)).toBe(false);
  });
});

describe("createStackForDeployment create-or-update collapse (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should UpdateStack when the existing stack is healthy", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "CREATE_COMPLETE" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);

    expect(result.stackId).toBe(UPDATE_STACK_ID);
    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).toContain("UpdateStackCommand");
    expect(kinds).not.toContain("CreateStackCommand");
    expect(kinds).not.toContain("DeleteStackCommand");
    const updateCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof UpdateStackCommand);
    const input = (updateCmd as UpdateStackCommand).input;
    // Same shape as the create path (template / params / capabilities / tags), no RoleARN cross-account.
    expect(input.StackName).toBe("tc-sample-flag-demo-team");
    expect(input.TemplateBody).toBe(artifacts.templateBody);
    expect(input.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(input.RoleARN).toBeUndefined();
    expect(input.Parameters).toContainEqual({
      ParameterKey: "NamePrefix",
      ParameterValue: "tc-sample-flag-demo-team",
    });
    expect(input.Tags?.some((t) => t.Key === "TenkaCloud:DeployedBy")).toBe(true);
  });

  it("should pass the CFn exec RoleARN on a same-account UpdateStack", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "UPDATE_COMPLETE" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment(
      { detail: validDetail({ competitorRoleArn: undefined, externalIdParameterName: undefined }) },
      deps,
    );
    const updateCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof UpdateStackCommand);
    expect((updateCmd as UpdateStackCommand).input.RoleARN).toBe(
      "arn:aws:iam::999988887777:role/CfnExec",
    );
  });

  it('should treat "No updates are to be performed" as a successful no-op', async () => {
    const cfn = fakeCfn({
      // describe #1 = classify (healthy), describe #2 = describeStackId for the no-op return value.
      describeResponses: [{ status: "UPDATE_COMPLETE" }, { status: "UPDATE_COMPLETE" }],
      commands: [],
      updateThrows: "No updates are to be performed.",
    });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);

    // No-op resolves the StackId from DescribeStacks; the deploy does not fail and never CreateStacks.
    expect(result.stackId).toBe("arn:stack/id");
    expect(cfn.send.mock.calls.some((c) => c[0] instanceof CreateStackCommand)).toBe(false);
  });

  it("should return no stackId when the no-op DescribeStacks cannot resolve one", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "UPDATE_COMPLETE" }, { notFound: true }],
      commands: [],
      updateThrows: "No updates are to be performed.",
    });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);
    expect(result).toEqual({});
  });

  it("should re-throw a non-'not found' DescribeStacks error while resolving the no-op StackId", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "UPDATE_COMPLETE" }, { throw: "Throttling" }],
      commands: [],
      updateThrows: "No updates are to be performed.",
    });
    const deps = crossAccountDeps(cfn);
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /Throttling/,
    );
  });

  it("should still succeed when UpdateStack returns no StackId", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "CREATE_COMPLETE" }],
      commands: [],
      updateNoStackId: true,
    });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);
    expect(result.stackId).toBeUndefined();
  });

  it("should re-throw a non-no-op UpdateStack failure (fail loud)", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "CREATE_COMPLETE" }],
      commands: [],
      updateThrows: "InsufficientCapabilities",
    });
    const deps = crossAccountDeps(cfn);
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /InsufficientCapabilities/,
    );
  });

  it("should still CreateStack when the stack is absent", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const result = await createStackForDeployment({ detail: validDetail() }, deps);

    expect(result.stackId).toBe("arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1");
    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).toContain("CreateStackCommand");
    expect(kinds).not.toContain("UpdateStackCommand");
  });

  it("should delete then re-create an unrecoverable stack", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "ROLLBACK_COMPLETE" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment({ detail: validDetail() }, deps);

    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds.indexOf("DeleteStackCommand")).toBeLessThan(kinds.indexOf("CreateStackCommand"));
    expect(kinds).not.toContain("UpdateStackCommand");
    expect(deps.waitForStackDelete).toHaveBeenCalledOnce();
  });

  it("should fail loudly on a transitional *_IN_PROGRESS state", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "UPDATE_IN_PROGRESS" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /is currently UPDATE_IN_PROGRESS; cannot deploy until it settles/,
    );
    // Loud fail — no silent skip: nothing was created / updated / deleted.
    const kinds = cfn.send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).not.toContain("CreateStackCommand");
    expect(kinds).not.toContain("UpdateStackCommand");
    expect(kinds).not.toContain("DeleteStackCommand");
  });

  it("should propagate a non-'not found' DescribeStacks error before deploy (fail loud)", async () => {
    const cfn = fakeCfn({ describeResponses: [{ throw: "Throttling" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /Throttling/,
    );
  });
});

describe("createStackForDeployment progress logging (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  function recordingProgressFactory() {
    const messages: string[] = [];
    const jobIds: string[] = [];
    const factory = (jobId: string) => {
      jobIds.push(jobId);
      return {
        info: async (message: string) => {
          messages.push(message);
        },
      };
    };
    return { factory, messages, jobIds };
  }

  it("should stream progress lines to the job logger when a progressFactory is provided", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await createStackForDeployment({ detail: validDetail() }, deps);

    // The factory is keyed by the deploy jobId.
    expect(rec.jobIds).toEqual([VALID_JOB_ID]);
    // Human-readable transitions mirror what a CodeBuild log would show — and carry no secrets.
    expect(rec.messages).toContain("Deploying stack tc-sample-flag-demo-team ...");
    expect(rec.messages.some((m) => m.startsWith("CreateStack submitted (stackId "))).toBe(true);
    expect(rec.messages.join("\n")).not.toContain("external-id-secret-value");
  });

  it("should emit a delete line when a pre-existing unrecoverable stack is removed", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "ROLLBACK_COMPLETE" }], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await createStackForDeployment({ detail: validDetail() }, deps);

    expect(
      rec.messages.some((m) =>
        m.startsWith("Deleting unrecoverable stack (ROLLBACK_COMPLETE) before re-create"),
      ),
    ).toBe(true);
  });

  it("should not require a logger (NOOP) when progressFactory is absent", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn); // no progressFactory
    const result = await createStackForDeployment({ detail: validDetail() }, deps);
    expect(result.stackId).toBe("arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1");
  });

  it("should not fail the deploy when a progress write throws (best-effort logging)", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const throwingFactory = () => ({
      info: async () => {
        throw new Error("CloudWatch unavailable");
      },
    });
    const deps = { ...crossAccountDeps(cfn), progressFactory: throwingFactory };
    const result = await createStackForDeployment({ detail: validDetail() }, deps);
    // Deploy still succeeded despite every progress write failing.
    expect(result.stackId).toBe("arn:aws:cloudformation:ap-northeast-1:123456789012:stack/tc/1");
  });

  it("should emit a 'Deploy failed' line and rethrow when CreateStack fails", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    cfn.send.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateStackCommand) throw new Error("AlreadyExistsException");
      if (command instanceof DescribeStacksCommand) {
        throw new Error("Stack with id tc-sample-flag-demo-team does not exist");
      }
      return {};
    });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /AlreadyExistsException/,
    );
    expect(rec.messages.some((m) => m.startsWith("Deploy failed: "))).toBe(true);
  });

  it("should stream Update progress lines when the existing stack is healthy", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "CREATE_COMPLETE" }], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await createStackForDeployment({ detail: validDetail() }, deps);

    expect(rec.messages).toContain("Updating stack tc-sample-flag-demo-team ...");
    expect(rec.messages.some((m) => m.startsWith("UpdateStack submitted (stackId "))).toBe(true);
    expect(rec.messages.join("\n")).not.toContain("external-id-secret-value");
  });

  it("should emit a 'No changes to apply' line on a no-op update", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "UPDATE_COMPLETE" }, { status: "UPDATE_COMPLETE" }],
      commands: [],
      updateThrows: "No updates are to be performed.",
    });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await createStackForDeployment({ detail: validDetail() }, deps);
    expect(rec.messages).toContain("No changes to apply");
  });

  it("should emit a 'Deploy failed' line and rethrow when UpdateStack fails (non no-op)", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "CREATE_COMPLETE" }],
      commands: [],
      updateThrows: "InsufficientCapabilities",
    });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await expect(createStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /InsufficientCapabilities/,
    );
    expect(rec.messages.some((m) => m.startsWith("Deploy failed: "))).toBe(true);
  });
});

describe("createStackForDeployment same-account (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should skip AssumeRole and pass the CFn exec RoleARN when no competitor role is set", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await createStackForDeployment(
      { detail: validDetail({ competitorRoleArn: undefined, externalIdParameterName: undefined }) },
      deps,
    );
    // Same-account: no AssumeRole.
    expect(deps._stsSend).not.toHaveBeenCalled();
    const createCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof CreateStackCommand);
    expect((createCmd as CreateStackCommand).input.RoleARN).toBe(
      "arn:aws:iam::999988887777:role/CfnExec",
    );
  });
});
