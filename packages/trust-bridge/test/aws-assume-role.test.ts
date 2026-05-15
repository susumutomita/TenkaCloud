import { describe, expect, it } from "vitest";
import {
  type AssumeRoleInput,
  type AssumeRoleOutput,
  AwsAssumeRoleExchange,
  type StsAssumeRoleClient,
} from "../src/aws-assume-role.js";
import { ExchangeError } from "../src/provider.js";
import {
  brandVerified,
  type CloudActionIntent,
  INTENT_VERSION,
  type VerifiedCloudActionIntent,
} from "../src/schema.js";

function makeIntent(overrides: Partial<CloudActionIntent> = {}): VerifiedCloudActionIntent {
  const intent: CloudActionIntent = {
    version: INTENT_VERSION,
    requestId: "req-aws-1",
    nonce: "nonce-aws-1",
    source: {
      system: "tenkacloud",
      tenantId: "tenant-a",
      teamId: "team-alpha",
      problemId: "hello-world",
      deploymentId: "deploy-9",
      workloadId: "deploy-worker",
    },
    target: { provider: "aws", providerAccountRef: "123456789012" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack", "cloudformation:DescribeStacks"],
    },
    constraints: {
      ttlSeconds: 1800,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
  return brandVerified(intent);
}

function makeStub(
  output: Partial<AssumeRoleOutput> = {},
  capture?: (input: AssumeRoleInput) => void,
): StsAssumeRoleClient {
  return {
    assumeRole: async (input: AssumeRoleInput) => {
      capture?.(input);
      return {
        Credentials: {
          AccessKeyId: output.Credentials?.AccessKeyId ?? "ASIA-test",
          SecretAccessKey: output.Credentials?.SecretAccessKey ?? "secret",
          SessionToken: output.Credentials?.SessionToken ?? "token",
          Expiration: output.Credentials?.Expiration ?? new Date("2026-05-15T20:30:00.000Z"),
        },
        AssumedRoleUser: {
          Arn: output.AssumedRoleUser?.Arn ?? "arn:aws:sts::123456789012:assumed-role/X/Y",
        },
      };
    },
  };
}

describe("AwsAssumeRoleExchange (#795 Phase 2)", () => {
  it("provider が aws でない intent では provider-mismatch を投げるべき", async () => {
    const ex = new AwsAssumeRoleExchange({ sts: makeStub() });
    const intent = makeIntent({
      target: { provider: "gcp", providerAccountRef: "my-project" },
    });
    await expect(
      ex.exchange(intent, { roleArn: "arn:aws:iam::1:role/x", externalId: "abc" }),
    ).rejects.toMatchObject({ reason: "provider-mismatch" });
  });

  it("context.roleArn が無いと context-missing を投げるべき", async () => {
    const ex = new AwsAssumeRoleExchange({ sts: makeStub() });
    await expect(
      ex.exchange(makeIntent(), { externalId: "ext-1" } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("context.externalId が無いと context-missing を投げるべき (= ADR-002 必須化)", async () => {
    const ex = new AwsAssumeRoleExchange({ sts: makeStub() });
    await expect(
      ex.exchange(makeIntent(), { roleArn: "arn:aws:iam::1:role/x" } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("ttlSeconds が STS 最小 900 未満なら ttl-exceeded-provider-limit を投げるべき", async () => {
    const ex = new AwsAssumeRoleExchange({ sts: makeStub() });
    const intent = makeIntent();
    const short: CloudActionIntent = {
      ...intent,
      constraints: { ...intent.constraints, ttlSeconds: 600 },
    };
    await expect(
      ex.exchange(brandVerified(short), {
        roleArn: "arn:aws:iam::1:role/x",
        externalId: "ext-1",
      }),
    ).rejects.toMatchObject({ reason: "ttl-exceeded-provider-limit" });
  });

  it("STS が throw したら provider-api-error に wrap するべき (= underlying 保持)", async () => {
    const failingSts: StsAssumeRoleClient = {
      assumeRole: async () => {
        throw new Error("STS unreachable");
      },
    };
    const ex = new AwsAssumeRoleExchange({ sts: failingSts });
    try {
      await ex.exchange(makeIntent(), {
        roleArn: "arn:aws:iam::1:role/x",
        externalId: "ext-1",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExchangeError);
      const ee = err as ExchangeError;
      expect(ee.reason).toBe("provider-api-error");
      expect((ee.underlying as Error).message).toBe("STS unreachable");
    }
  });

  it("成功 path で AssumeRoleCommand input に DurationSeconds / ExternalId / Policy / Tags を正しく載せるべき", async () => {
    let captured: AssumeRoleInput | undefined;
    const sts = makeStub({}, (input) => {
      captured = input;
    });
    const ex = new AwsAssumeRoleExchange({ sts });
    const result = await ex.exchange(makeIntent(), {
      roleArn: "arn:aws:iam::1:role/x",
      externalId: "ext-secret",
    });
    expect(captured).toBeDefined();
    expect(captured?.RoleArn).toBe("arn:aws:iam::1:role/x");
    expect(captured?.ExternalId).toBe("ext-secret");
    expect(captured?.DurationSeconds).toBe(1800);
    expect(captured?.Policy).toContain('"Effect":"Allow"');
    expect(captured?.Policy).toContain("cloudformation:CreateStack");
    expect(captured?.Policy).toContain("cloudformation:DescribeStacks");
    const tags = captured?.Tags ?? [];
    expect(tags.find((t) => t.Key === "tenkacloud:tenantId")?.Value).toBe("tenant-a");
    expect(tags.find((t) => t.Key === "tenkacloud:teamId")?.Value).toBe("team-alpha");
    expect(tags.find((t) => t.Key === "tenkacloud:requestId")?.Value).toBe("req-aws-1");
    expect(result.provider).toBe("aws");
    expect(result.forRequestId).toBe("req-aws-1");
    expect(result.externalId).toBe("ext-secret");
  });

  it("RoleSessionName は default で intent claim から組み立て、 64 文字 cap されるべき", async () => {
    let captured: AssumeRoleInput | undefined;
    const sts = makeStub({}, (input) => {
      captured = input;
    });
    const ex = new AwsAssumeRoleExchange({ sts });
    const intent = makeIntent({
      requestId: "req-very-long-id-that-keeps-going-and-going-and-going",
      source: {
        system: "tenkacloud",
        tenantId: "tenant-with-long-id",
        teamId: "team-with-long-id",
        workloadId: "w-1",
      },
    });
    await ex.exchange(intent, { roleArn: "arn:aws:iam::1:role/x", externalId: "ext-1" });
    expect(captured?.RoleSessionName.length).toBeLessThanOrEqual(64);
  });

  it("requestedScopes が空なら Policy 省略されるべき (= default = role policy のみ)", async () => {
    let captured: AssumeRoleInput | undefined;
    const sts = makeStub({}, (input) => {
      captured = input;
    });
    const ex = new AwsAssumeRoleExchange({ sts });
    const intent = makeIntent();
    const noScopes: CloudActionIntent = {
      ...intent,
      action: { ...intent.action, requestedScopes: [] },
    };
    await ex.exchange(brandVerified(noScopes), {
      roleArn: "arn:aws:iam::1:role/x",
      externalId: "ext-1",
    });
    expect(captured?.Policy).toBeUndefined();
  });

  it("Expiration が string で返ってきても ISO に正規化されるべき", async () => {
    const sts: StsAssumeRoleClient = {
      assumeRole: async () => ({
        Credentials: {
          AccessKeyId: "K",
          SecretAccessKey: "S",
          SessionToken: "T",
          Expiration: "2026-05-15T22:00:00Z",
        },
        AssumedRoleUser: { Arn: "arn:aws:sts::1:assumed-role/x/y" },
      }),
    };
    const ex = new AwsAssumeRoleExchange({ sts });
    const result = await ex.exchange(makeIntent(), {
      roleArn: "arn:aws:iam::1:role/x",
      externalId: "ext-1",
    });
    expect(result.expiresAt).toBe("2026-05-15T22:00:00.000Z");
  });
});
