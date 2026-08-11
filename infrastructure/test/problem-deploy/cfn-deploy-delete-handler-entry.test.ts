import { DeleteStackCommand, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #2291: coverage for the DELETE handler's **real-SDK entry** wiring
 * (`deleteHandler` / `describeDeleteHandler` → `buildRealDeps` → `sdkCredentials`), which the
 * dep-injected tests in `cfn-deploy-delete-handler.test.ts` never exercise. Only the SDK **client**
 * constructors are mocked (via `importOriginal`, so the `*Command` classes stay real and the
 * production code's command construction is unchanged); a single shared `send` dispatches by real
 * command type. This drives the exact orchestration ported from `scripts/delete-battles.sh`
 * (GetParameter → AssumeRole → GetCallerIdentity #1797 guard → DeleteStack / DescribeStacks) through
 * the real client factory, so the credential-shaping + client-building lines are covered without
 * touching AWS.
 */

const ACCOUNT_ID = "123456789012";
const send = vi.fn();

// `new SSMClient({})` runs at import time, so the mock factory must be newable — a `function`
// (not an arrow) is both a constructor and a vitest spy (so `toHaveBeenCalledWith` still works).
vi.mock("@aws-sdk/client-cloudformation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cloudformation")>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(function CloudFormationClient() {
      return { send };
    }),
  };
});
vi.mock("@aws-sdk/client-ssm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-ssm")>();
  return {
    ...actual,
    SSMClient: vi.fn(function SSMClient() {
      return { send };
    }),
  };
});
vi.mock("@aws-sdk/client-sts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sts")>();
  return {
    ...actual,
    STSClient: vi.fn(function STSClient() {
      return { send };
    }),
  };
});

const { deleteHandler, describeDeleteHandler } = await import(
  "../../lib/problem-deploy/handlers/cfn-deploy-handler/delete-stack.js"
);

function validDetail(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "01HX0000000000000000000ABC",
    tenantId: "tenant-acme",
    stackName: "tc-sample-flag-demo-team",
    region: "ap-northeast-1",
    awsAccountId: ACCOUNT_ID,
    competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeployRole",
    externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    ...overrides,
  };
}

/** Dispatch by real command class — the same one `send` backs every mocked client. */
function scriptSend(describe: () => unknown): void {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetParameterCommand) {
      return { Parameter: { Value: "external-id-secret-value", Version: 1 } };
    }
    if (command instanceof AssumeRoleCommand) {
      return {
        Credentials: {
          AccessKeyId: "AKIA_TEST",
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: new Date(),
        },
      };
    }
    if (command instanceof GetCallerIdentityCommand) return { Account: ACCOUNT_ID };
    if (command instanceof DeleteStackCommand) return {};
    if (command instanceof DescribeStacksCommand) return describe();
    throw new Error(`unexpected command: ${(command as object).constructor.name}`);
  });
}

describe("cfn-deploy delete handler real-SDK entries (#2291)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CFN_EXEC_ROLE_ARN;
  });
  afterEach(() => {
    delete process.env.CFN_EXEC_ROLE_ARN;
  });

  it("should build real SDK clients and delete the stack through deleteHandler", async () => {
    scriptSend(() => ({ Stacks: [{ StackStatus: "DELETE_IN_PROGRESS" }] }));
    const result = await deleteHandler({ action: "delete", detail: validDetail() });
    expect(result).toEqual({ deleted: true });
    // The GetCallerIdentity #1797 guard and the DeleteStack both ran through the built clients.
    const kinds = send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(kinds).toContain("GetCallerIdentityCommand");
    expect(kinds).toContain("DeleteStackCommand");
  });

  it("should shape assumed credentials onto the CFn client (sdkCredentials) for deleteHandler", async () => {
    scriptSend(() => ({ Stacks: [] }));
    const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
    await deleteHandler({ action: "delete", detail: validDetail() });
    // The competitor-region CFn client is constructed with the assumed-role credentials.
    expect(CloudFormationClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "ap-northeast-1",
        credentials: expect.objectContaining({ accessKeyId: "AKIA_TEST", sessionToken: "token" }),
      }),
    );
  });

  it("should poll delete status through describeDeleteHandler", async () => {
    scriptSend(() => ({ Stacks: [{ StackStatus: "DELETE_IN_PROGRESS" }] }));
    const result = await describeDeleteHandler({
      action: "describe-delete",
      detail: validDetail(),
    });
    expect(result.Stacks[0].StackStatus).toBe("DELETE_IN_PROGRESS");
  });

  it("should normalize an already-gone stack to DELETE_COMPLETE through describeDeleteHandler", async () => {
    scriptSend(() => {
      throw new Error("Stack with id tc-sample-flag-demo-team does not exist");
    });
    const result = await describeDeleteHandler({
      action: "describe-delete",
      detail: validDetail(),
    });
    expect(result.Stacks[0].StackStatus).toBe("DELETE_COMPLETE");
  });
});
