import { DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStackForDeployment,
  describeDeleteStackForPoll,
  isStackAlreadyDeletedError,
} from "../../lib/problem-deploy/handlers/cfn-deploy-handler/delete-stack.js";

/**
 * Issue #2291: Lambda DeleteStack deploy handler unit tests (the DELETE mirror of
 * `cfn-deploy-handler.test.ts`). All AWS SDK clients are mocked via injected `send` fakes (no
 * network). The tests lock the behavior ported from `scripts/delete-battles.sh`: ExternalId
 * resolution + cross-account AssumeRole, the #1797 account-mismatch guard, DeleteStack idempotency
 * (already-gone = no-op success), and the DescribeStacks poll normalization (gone = DELETE_COMPLETE).
 */

const VALID_JOB_ID = "01HX0000000000000000000ABC"; // >= 16 chars (ULID-shaped)
const STACK_NAME = "tc-sample-flag-demo-team";
const ACCOUNT_ID = "123456789012";

function validDetail(overrides: Record<string, unknown> = {}) {
  return {
    jobId: VALID_JOB_ID,
    tenantId: "tenant-acme",
    stackName: STACK_NAME,
    region: "ap-northeast-1",
    awsAccountId: ACCOUNT_ID,
    competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeployRole",
    externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    ...overrides,
  };
}

interface FakeCfnState {
  readonly describeResponses: Array<{
    status?: string;
    reason?: string;
    notFound?: boolean;
    empty?: boolean;
    throw?: string;
  }>;
  readonly commands: unknown[];
  deleteThrows?: string;
}

function scriptedDescribe(scripted: FakeCfnState["describeResponses"][number]) {
  if (scripted.notFound) throw new Error(`Stack with id ${STACK_NAME} does not exist`);
  if (scripted.throw) throw new Error(scripted.throw);
  return {
    Stacks: scripted.empty
      ? []
      : [
          {
            StackStatus: scripted.status,
            StackStatusReason: scripted.reason,
            StackId: "arn:stack/id",
          },
        ],
  };
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
      if (command instanceof DeleteStackCommand) {
        if (state.deleteThrows) throw new Error(state.deleteThrows);
        return {};
      }
      throw new Error(`unexpected command: ${(command as object).constructor.name}`);
    }),
  };
}

function crossAccountDeps(cfn: ReturnType<typeof fakeCfn>, opts: { callerAccount?: string } = {}) {
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
  const identitySend = vi.fn(async () => ({ Account: opts.callerAccount ?? ACCOUNT_ID }));
  return {
    ssm: { send: ssmSend },
    sts: { send: stsSend },
    cfnClient: vi.fn(() => cfn),
    stsIdentityClient: vi.fn(() => ({ send: identitySend })),
    cfnExecRoleArn: "arn:aws:iam::999988887777:role/CfnExec",
    _ssmSend: ssmSend,
    _stsSend: stsSend,
    _identitySend: identitySend,
  };
}

describe("isStackAlreadyDeletedError (#2291)", () => {
  it("should match ValidationError / 'does not exist' and nothing else", () => {
    expect(isStackAlreadyDeletedError(new Error("Stack tc-x does not exist"))).toBe(true);
    expect(isStackAlreadyDeletedError(new Error("ValidationError: no such stack"))).toBe(true);
    expect(isStackAlreadyDeletedError(new Error("Throttling"))).toBe(false);
    expect(isStackAlreadyDeletedError("not-an-error")).toBe(false);
  });
});

describe("deleteStackForDeployment cross-account (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should resolve the ExternalId from SSM and AssumeRole with ExternalId before DeleteStack", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await deleteStackForDeployment({ detail: validDetail() }, deps);

    const getParam = deps._ssmSend.mock.calls[0][0];
    expect(getParam).toBeInstanceOf(GetParameterCommand);
    expect(getParam.input).toMatchObject({
      Name: "/development/tenants/tenant-acme/external-id",
      WithDecryption: true,
    });
    const assume = deps._stsSend.mock.calls[0][0];
    expect(assume).toBeInstanceOf(AssumeRoleCommand);
    expect(assume.input).toMatchObject({
      RoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeployRole",
      ExternalId: "external-id-secret-value",
    });
  });

  it("should DeleteStack with the correct StackName and no RoleARN cross-account", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    const result = await deleteStackForDeployment({ detail: validDetail() }, deps);

    expect(result.deleted).toBe(true);
    const deleteCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof DeleteStackCommand);
    expect(deleteCmd).toBeInstanceOf(DeleteStackCommand);
    const input = (deleteCmd as DeleteStackCommand).input;
    expect(input.StackName).toBe(STACK_NAME);
    // Cross-account uses assumed creds → no platform RoleARN passed.
    expect(input.RoleARN).toBeUndefined();
    // CFn client built for the competitor region + assumed credentials.
    expect(deps.cfnClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "ap-northeast-1",
        credentials: expect.objectContaining({ AccessKeyId: "AKIA_TEST" }),
      }),
    );
  });

  it("should verify GetCallerIdentity account matches the stack account before DeleteStack (#1797)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await deleteStackForDeployment({ detail: validDetail() }, deps);

    // GetCallerIdentity runs under the assumed creds, before the DeleteStack call.
    const identityCmd = deps._identitySend.mock.calls[0][0];
    expect(identityCmd).toBeInstanceOf(GetCallerIdentityCommand);
    expect(deps.stsIdentityClient).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ AccessKeyId: "AKIA_TEST" }),
      }),
    );
    expect(deps._identitySend).toHaveBeenCalledBefore(cfn.send as never);
  });

  it("should fail loud when credentials target a different account than the stack (#1797)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn, { callerAccount: "999999999999" });
    await expect(deleteStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /would silently survive/,
    );
    // Never reached DeleteStack.
    expect(cfn.send.mock.calls.some((c) => c[0] instanceof DeleteStackCommand)).toBe(false);
  });

  it("should fail loud when GetCallerIdentity returns no Account", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    deps._identitySend.mockResolvedValueOnce({});
    await expect(deleteStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /GetCallerIdentity returned no Account/,
    );
  });

  it("should treat an already-deleted stack as a no-op success (idempotent)", async () => {
    const cfn = fakeCfn({
      describeResponses: [],
      commands: [],
      deleteThrows: "Stack does not exist",
    });
    const deps = crossAccountDeps(cfn);
    const result = await deleteStackForDeployment({ detail: validDetail() }, deps);
    expect(result.deleted).toBe(true);
  });

  it("should propagate a non-'already deleted' DeleteStack error (fail loud)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [], deleteThrows: "Throttling" });
    const deps = crossAccountDeps(cfn);
    await expect(deleteStackForDeployment({ detail: validDetail() }, deps)).rejects.toThrow(
      /Throttling/,
    );
  });

  it("should reject an invalid event detail (schema fail-loud)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(
      deleteStackForDeployment({ detail: validDetail({ region: "not-a-region" }) }, deps),
    ).rejects.toThrow();
  });

  it("should reject when only one of competitorRoleArn / externalIdParameterName is present", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(
      deleteStackForDeployment(
        { detail: validDetail({ externalIdParameterName: undefined }) },
        deps,
      ),
    ).rejects.toThrow(/must be provided together/);
  });
});

describe("deleteStackForDeployment same-account (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should skip AssumeRole and pass the CFn exec RoleARN when no competitor role is set", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const deps = crossAccountDeps(cfn);
    await deleteStackForDeployment(
      { detail: validDetail({ competitorRoleArn: undefined, externalIdParameterName: undefined }) },
      deps,
    );
    // Same-account: no AssumeRole.
    expect(deps._stsSend).not.toHaveBeenCalled();
    const deleteCmd = cfn.send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof DeleteStackCommand);
    expect((deleteCmd as DeleteStackCommand).input.RoleARN).toBe(
      "arn:aws:iam::999988887777:role/CfnExec",
    );
  });
});

describe("delete progress logging (#2291)", () => {
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

  it("should stream delete progress lines when a progressFactory is provided", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await deleteStackForDeployment({ detail: validDetail() }, deps);

    expect(rec.jobIds).toEqual([VALID_JOB_ID]);
    expect(rec.messages).toContain(`Deleting stack ${STACK_NAME} ...`);
    expect(rec.messages).toContain(`Delete submitted for stack ${STACK_NAME}`);
    expect(rec.messages.join("\n")).not.toContain("external-id-secret-value");
  });

  it("should emit 'Delete complete' when the stack was already gone (idempotent)", async () => {
    const cfn = fakeCfn({
      describeResponses: [],
      commands: [],
      deleteThrows: "Stack does not exist",
    });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await deleteStackForDeployment({ detail: validDetail() }, deps);
    expect(rec.messages).toContain("Delete complete");
  });

  it("should not require a logger (NOOP) when progressFactory is absent", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const result = await deleteStackForDeployment({ detail: validDetail() }, crossAccountDeps(cfn));
    expect(result.deleted).toBe(true);
  });

  it("should not fail the delete when a progress write throws (best-effort logging)", async () => {
    const cfn = fakeCfn({ describeResponses: [], commands: [] });
    const throwingFactory = () => ({
      info: async () => {
        throw new Error("CloudWatch unavailable");
      },
    });
    const deps = { ...crossAccountDeps(cfn), progressFactory: throwingFactory };
    const result = await deleteStackForDeployment({ detail: validDetail() }, deps);
    expect(result.deleted).toBe(true);
  });

  it("should emit a 'Delete complete' terminal line from the poll when the stack is gone", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(rec.messages).toContain("Delete complete");
  });

  it("should emit a 'Delete failed' terminal line from the poll on DELETE_FAILED", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "DELETE_FAILED", reason: "S3 bucket not empty" }],
      commands: [],
    });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(rec.messages).toContain("Delete failed: S3 bucket not empty");
  });

  it("should not emit a terminal line while the delete is still in progress", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "DELETE_IN_PROGRESS" }], commands: [] });
    const rec = recordingProgressFactory();
    const deps = { ...crossAccountDeps(cfn), progressFactory: rec.factory };
    await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(rec.messages).toEqual([]);
  });
});

describe("describeDeleteStackForPoll (#2291)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return the real StackStatus while the stack still exists", async () => {
    const cfn = fakeCfn({ describeResponses: [{ status: "DELETE_IN_PROGRESS" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const out = await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(out.Stacks[0].StackStatus).toBe("DELETE_IN_PROGRESS");
    expect(out.Stacks[0].StackId).toBe("arn:stack/id");
  });

  it("should normalize a gone stack (does not exist) to DELETE_COMPLETE", async () => {
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const out = await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(out.Stacks[0].StackStatus).toBe("DELETE_COMPLETE");
    expect(out.Stacks[0].StackId).toBe(STACK_NAME);
  });

  it("should normalize an empty Stacks array to DELETE_COMPLETE", async () => {
    const cfn = fakeCfn({ describeResponses: [{ empty: true }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const out = await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(out.Stacks[0].StackStatus).toBe("DELETE_COMPLETE");
  });

  it("should surface DELETE_FAILED with its StackStatusReason", async () => {
    const cfn = fakeCfn({
      describeResponses: [{ status: "DELETE_FAILED", reason: "S3 bucket not empty" }],
      commands: [],
    });
    const deps = crossAccountDeps(cfn);
    const out = await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(out.Stacks[0].StackStatus).toBe("DELETE_FAILED");
    expect(out.Stacks[0].StackStatusReason).toBe("S3 bucket not empty");
  });

  it("should propagate a non-'gone' DescribeStacks error (fail loud)", async () => {
    const cfn = fakeCfn({ describeResponses: [{ throw: "Throttling" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    await expect(describeDeleteStackForPoll({ detail: validDetail() }, deps)).rejects.toThrow(
      /Throttling/,
    );
  });

  it("should attach a fallback StackStatusReason on DELETE_FAILED without a reason (#2291)", async () => {
    // CloudFormation does not always populate StackStatusReason. The SM's DELETE_FAILED branch reads
    // it via JsonPath, so a missing field would throw States.Runtime and strand the row in DELETING.
    const cfn = fakeCfn({ describeResponses: [{ status: "DELETE_FAILED" }], commands: [] });
    const deps = crossAccountDeps(cfn);
    const out = await describeDeleteStackForPoll({ detail: validDetail() }, deps);
    expect(out.Stacks[0].StackStatus).toBe("DELETE_FAILED");
    expect(out.Stacks[0].StackStatusReason).toBe(
      "CloudFormation reported DELETE_FAILED without a reason",
    );
  });

  it("should fail loud when the poll 'gone' path lands on the wrong account (#1797)", async () => {
    // A name miss under drifted credentials must not advance teardown for another account.
    const cfn = fakeCfn({ describeResponses: [{ notFound: true }], commands: [] });
    const deps = crossAccountDeps(cfn, { callerAccount: "999999999999" });
    await expect(describeDeleteStackForPoll({ detail: validDetail() }, deps)).rejects.toThrow(
      /would silently survive/,
    );
  });
});
