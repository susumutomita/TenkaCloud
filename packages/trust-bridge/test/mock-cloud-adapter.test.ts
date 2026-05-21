import { describe, expect, it } from "vitest";
import { MockCloudAdapter } from "../src/mock-cloud-adapter.js";
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
    requestId: "req-mock-1",
    nonce: "nonce-mock-1",
    source: {
      system: "tenkacloud",
      tenantId: "tenant-a",
      teamId: "team-alpha",
      problemId: "hello-world",
      deploymentId: "deploy-9",
      workloadId: "deploy-worker",
    },
    target: { provider: "aws", providerAccountRef: "123456789012", region: "ap-northeast-1" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
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

describe("MockCloudAdapter (#1122)", () => {
  it("should return a fake credential and success signal without calling a real provider API", async () => {
    const adapter = new MockCloudAdapter({
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });

    const credential = await adapter.exchange(makeIntent(), {});

    expect(credential.provider).toBe("aws");
    expect(credential.mode).toBe("mock");
    expect(credential.issuedAt).toBe("2026-05-15T19:00:00.000Z");
    expect(credential.expiresAt).toBe("2026-05-15T19:10:00.000Z");
    expect(credential.forRequestId).toBe("req-mock-1");
    expect(credential.accountRef).toBe("123456789012");
    expect(credential.region).toBe("ap-northeast-1");
    expect(credential.accessKeyId).toBe("MOCK-req-mock-1");
    expect(credential.secretAccessKey).toBe("mock-secret-not-valid-for-cloud-provider");
    expect(credential.sessionToken).toBe("mock-session-nonce-mock-1");
    expect(credential.deploymentSignal).toEqual({
      status: "SUCCEEDED",
      actionType: "deploy",
      engine: "cloudformation",
      requestId: "req-mock-1",
    });
  });

  it("should throw provider-mismatch when the target provider differs from the adapter provider", async () => {
    const adapter = new MockCloudAdapter({ provider: "gcp" });
    await expect(adapter.exchange(makeIntent(), {})).rejects.toMatchObject({
      reason: "provider-mismatch",
    });
  });

  it("should throw ttl-exceeded-provider-limit when ttlSeconds exceeds options.maxTtlSeconds", async () => {
    const adapter = new MockCloudAdapter({ maxTtlSeconds: 300 });
    await expect(adapter.exchange(makeIntent(), {})).rejects.toMatchObject({
      reason: "ttl-exceeded-provider-limit",
    });
  });

  it("should propagate the context traceLabel into the signal", async () => {
    const adapter = new MockCloudAdapter();
    const credential = await adapter.exchange(makeIntent(), { traceLabel: "offline-demo" });
    expect(credential.deploymentSignal.traceLabel).toBe("offline-demo");
  });

  it("should be treatable as an ExchangeError", async () => {
    const adapter = new MockCloudAdapter({ provider: "azure" });
    try {
      await adapter.exchange(makeIntent(), {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExchangeError);
    }
  });
});
