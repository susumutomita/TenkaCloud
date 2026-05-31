import { describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: describe-stack-handler/index.ts の残カバレッジ。 既存 describe-stack-handler.test.ts
 * は describeStackForDeployment を広く通すが、 assertCompleteCredentials の incomplete throw (L37)、
 * ExternalId-not-found throw (L89)、 logInputShape の field-detection 枝、 production `handler`
 * wrapper の credentials 有無両 branch (L252-268) が未カバーだった。
 *
 * handler は module-scope で real AWS client を組むため、 sts / ssm / cloudformation を mock し
 * controllable に。 残り (37/89/logInputShape) は injected deps で describeStackForDeployment を直接叩く。
 */
vi.mock("@aws-sdk/client-cloudformation", () => ({
  CloudFormationClient: class {
    send = vi.fn().mockRejectedValue(new Error("cfn send rejected"));
  },
  DescribeStacksCommand: class {},
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = vi.fn().mockResolvedValue({
      Credentials: { AccessKeyId: "AKIA", SecretAccessKey: "secret", SessionToken: "token" },
    });
  },
  AssumeRoleCommand: class {},
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = vi.fn().mockResolvedValue({ Parameter: { Value: "external-id", Version: 1 } });
  },
  GetParameterCommand: class {},
}));

const { describeStackForDeployment, handler } = await import(
  "../../lib/problem-deploy/handlers/describe-stack-handler"
);

const withRole = {
  detail: {
    jobId: "01KRK6BATCE8QZHX663MQFX4E3",
    namePrefix: "tc-stack-team-1",
    region: "ap-northeast-1",
    competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
    externalIdParameterName: "/tc/external-id",
  },
};
// biome-ignore lint/suspicious/noExplicitAny: injected deps shape mirrors DescribeStackDeps.
const makeDeps = (over: Record<string, unknown>): any => ({
  ssm: { send: vi.fn(async () => ({ Parameter: { Value: "external", Version: 3 } })) },
  sts: {
    send: vi.fn(async () => ({
      Credentials: { AccessKeyId: "AKIA", SecretAccessKey: "secret", SessionToken: "token" },
    })),
  },
  cfnClient: vi.fn(() => ({ send: vi.fn(async () => ({ Stacks: [] })) })),
  ...over,
});

describe("describeStackForDeployment defensive throws", () => {
  it("should throw when AssumeRole returns incomplete credentials (L37)", async () => {
    const deps = makeDeps({
      sts: { send: vi.fn(async () => ({ Credentials: { AccessKeyId: "AKIA" } })) }, // missing secret/session
    });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toThrow(
      /incomplete credentials/,
    );
  });

  it("should throw when the SSM ExternalId parameter has no value (L89)", async () => {
    const deps = makeDeps({
      ssm: { send: vi.fn(async () => ({ Parameter: { Value: undefined, Version: 1 } })) },
    });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toThrow(
      /ExternalId not found in SSM SecureString/,
    );
  });
});

describe("logInputShape diagnostics (missing jobId)", () => {
  it("should log every field as present when detail carries them (jobId empty)", async () => {
    const deps = makeDeps({});
    // jobId="" → logInputShape fires; all other fields present → the truthy side of each check.
    await expect(
      describeStackForDeployment(
        {
          detail: {
            jobId: "",
            namePrefix: "n",
            region: "ap-northeast-1",
            tenantId: "t",
            competitorRoleArn: "arn:aws:iam::1:role/r",
            externalIdParameterName: "/p",
          },
        },
        deps,
      ),
    ).rejects.toThrow(/detail.jobId/);
  });

  it("should handle a wholly absent detail (all fields falsy)", async () => {
    const deps = makeDeps({});
    await expect(describeStackForDeployment({}, deps)).rejects.toThrow(/detail.jobId/);
  });
});

const accessDenied = () => Object.assign(new Error("denied"), { name: "AccessDenied" });

describe("retryWithPreviousExternalId (ExternalId rotation grace)", () => {
  it("should grace-fallback to the previous ExternalId version on AccessDenied and succeed", async () => {
    const stsSend = vi.fn();
    stsSend.mockRejectedValueOnce(accessDenied()); // current version → denied
    stsSend.mockResolvedValueOnce({
      Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" },
    }); // previous version → ok
    const ssmSend = vi.fn();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "current", Version: 3 } });
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "previous", Version: 2 } });
    const deps = makeDeps({ sts: { send: stsSend }, ssm: { send: ssmSend } });
    await expect(describeStackForDeployment(withRole, deps)).resolves.toBeDefined();
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it("should rethrow when there is no previous version (Version defaults to 0)", async () => {
    const stsSend = vi.fn().mockRejectedValue(accessDenied());
    // Parameter has no Version → Number(undefined ?? 0) = 0 → previousVersion = -1 ≤ 0 → rethrow.
    const ssmSend = vi.fn(async () => ({ Parameter: { Value: "current" } }));
    const deps = makeDeps({ sts: { send: stsSend }, ssm: { send: ssmSend } });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toThrow(/denied/);
  });

  it("should rethrow when the previous-version parameter has no value", async () => {
    const stsSend = vi.fn().mockRejectedValue(accessDenied());
    const ssmSend = vi.fn();
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: "current", Version: 3 } });
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: undefined } }); // previous missing
    const deps = makeDeps({ sts: { send: stsSend }, ssm: { send: ssmSend } });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toThrow(/denied/);
  });

  it("should rethrow immediately on a non-retryable Error (not AccessDenied)", async () => {
    const stsSend = vi.fn().mockRejectedValue(new Error("Throttling"));
    const deps = makeDeps({ sts: { send: stsSend } });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toThrow(/Throttling/);
    expect(stsSend).toHaveBeenCalledTimes(1); // no grace retry
  });

  it("should rethrow immediately on a non-Error rejection (shouldRetry '' branch)", async () => {
    const stsSend = vi.fn().mockRejectedValue("plain string failure");
    const deps = makeDeps({ sts: { send: stsSend } });
    await expect(describeStackForDeployment(withRole, deps)).rejects.toBe("plain string failure");
  });
});

describe("handler production wrapper", () => {
  it("should wire real clients with no credentials when no competitor role is given", async () => {
    // competitorRoleArn 無し → AssumeRole skip → cfnClient(credentials=undefined) (= no-creds ternary)。
    await expect(
      handler({
        detail: {
          jobId: "01KRK6BATCE8QZHX663MQFX4E3",
          namePrefix: "tc-stack",
          region: "ap-northeast-1",
        },
      }),
    ).rejects.toThrow(/cfn send rejected/);
  });

  it("should wire real clients with assumed credentials when a competitor role is given", async () => {
    // competitorRoleArn + externalIdParameterName あり → mocked SSM/STS で creds 解決 →
    // cfnClient(credentials present) (= with-creds ternary L258-265) を踏む。 CFN send は reject。
    await expect(handler(withRole)).rejects.toThrow(/cfn send rejected/);
  });
});
