import { describe, expect, it } from "vitest";
import { LocalStackCloudAdapter } from "../src/localstack-cloud-adapter.js";
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
    requestId: "req-localstack-1",
    nonce: "nonce-localstack-1",
    source: {
      system: "tenkacloud",
      tenantId: "tenant-a",
      teamId: "team-alpha",
      problemId: "hello-world",
      deploymentId: "deploy-9",
      workloadId: "deploy-worker",
    },
    target: { provider: "aws", providerAccountRef: "000000000000", region: "ap-northeast-1" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack", "cloudformation:DescribeStacks"],
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
  return brandVerified(intent);
}

describe("LocalStackCloudAdapter (#1122)", () => {
  it("should return an AWS-shaped credential with a localhost endpoint", async () => {
    const adapter = new LocalStackCloudAdapter({
      endpointUrl: "http://localhost:4566/",
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });

    const credential = await adapter.exchange(makeIntent(), { traceLabel: "offline-demo" });

    expect(credential.provider).toBe("aws");
    expect(credential.mode).toBe("localstack");
    expect(credential.endpointUrl).toBe("http://localhost:4566");
    expect(credential.issuedAt).toBe("2026-05-15T19:00:00.000Z");
    expect(credential.expiresAt).toBe("2026-05-15T19:10:00.000Z");
    expect(credential.forRequestId).toBe("req-localstack-1");
    expect(credential.accountRef).toBe("000000000000");
    expect(credential.region).toBe("ap-northeast-1");
    expect(credential.accessKeyId).toBe("test");
    expect(credential.secretAccessKey).toBe("test");
    expect(credential.sessionToken).toBe("localstack-session-req-localstack-1");
    expect(credential.requestedScopes).toEqual([
      "cloudformation:CreateStack",
      "cloudformation:DescribeStacks",
    ]);
    expect(credential.traceLabel).toBe("offline-demo");
  });

  it("should override the adapter default endpoint with context endpointUrl", async () => {
    const adapter = new LocalStackCloudAdapter({ endpointUrl: "http://localhost:4566" });

    const credential = await adapter.exchange(makeIntent(), {
      endpointUrl: "http://127.0.0.1:4567",
    });

    expect(credential.endpointUrl).toBe("http://127.0.0.1:4567");
  });

  it("should default region to ap-northeast-1 when neither intent nor adapter sets it", async () => {
    const adapter = new LocalStackCloudAdapter({ endpointUrl: "http://localhost:4566" });
    const intent = makeIntent({ target: { provider: "aws", providerAccountRef: "000000000000" } });
    const credential = await adapter.exchange(intent, {});
    expect(credential.region).toBe("ap-northeast-1");
  });

  it("should throw for an invalid endpoint URL passed via context", async () => {
    const adapter = new LocalStackCloudAdapter({ endpointUrl: "http://localhost:4566" });
    await expect(
      adapter.exchange(makeIntent(), { endpointUrl: "not-a-valid-url" }),
    ).rejects.toBeInstanceOf(ExchangeError);
  });

  it("should throw provider-mismatch when the target provider is not aws", async () => {
    const adapter = new LocalStackCloudAdapter();
    await expect(
      adapter.exchange(
        makeIntent({ target: { provider: "gcp", providerAccountRef: "gcp-dev" } }),
        {},
      ),
    ).rejects.toMatchObject({ reason: "provider-mismatch" });
  });

  it("should reject any endpoint other than localhost", async () => {
    const adapter = new LocalStackCloudAdapter();
    await expect(
      adapter.exchange(makeIntent(), { endpointUrl: "https://localstack.example.com" }),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should throw ttl-exceeded-provider-limit when ttlSeconds exceeds options.maxTtlSeconds", async () => {
    const adapter = new LocalStackCloudAdapter({ maxTtlSeconds: 300 });
    await expect(adapter.exchange(makeIntent(), {})).rejects.toMatchObject({
      reason: "ttl-exceeded-provider-limit",
    });
  });

  it("should be treatable as an ExchangeError", async () => {
    try {
      new LocalStackCloudAdapter({ endpointUrl: "ftp://localhost:4566" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExchangeError);
    }
  });
});
