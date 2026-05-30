import { describe, expect, it } from "vitest";
import {
  type GcpStsClient,
  type GcpStsExchangeInput,
  GcpWorkloadIdentityFederationExchange,
  type GenerateServiceAccountTokenInput,
} from "../src/gcp-workload-identity.js";
import { ExchangeError } from "../src/provider.js";
import {
  brandVerified,
  type CloudActionIntent,
  INTENT_VERSION,
  type VerifiedCloudActionIntent,
} from "../src/schema.js";

function makeIntent(overrides: Partial<CloudActionIntent> = {}): VerifiedCloudActionIntent {
  return brandVerified({
    version: INTENT_VERSION,
    requestId: "req-gcp-1",
    nonce: "nonce-gcp-1",
    source: { system: "tenkacloud", tenantId: "tenant-x", workloadId: "w-1" },
    target: { provider: "gcp", providerAccountRef: "my-gcp-project" },
    action: {
      type: "deploy",
      engine: "terraform",
      requestedScopes: ["compute.instances.create"],
    },
    constraints: {
      ttlSeconds: 1800,
      expiresAt: "2026-05-16T00:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  });
}

function makeStubClient(captures?: {
  onExchange?: (input: GcpStsExchangeInput) => void;
  onGenerate?: (input: GenerateServiceAccountTokenInput) => void;
}): GcpStsClient {
  return {
    exchangeToken: async (input) => {
      captures?.onExchange?.(input);
      return { access_token: "federated-token-xyz", expires_in: 3600 };
    },
    generateServiceAccountToken: async (input) => {
      captures?.onGenerate?.(input);
      return {
        accessToken: "ya29.SA-access-token",
        expireTime: "2026-05-16T00:30:00.000Z",
      };
    },
  };
}

describe("GcpWorkloadIdentityFederationExchange (#795 Phase 4 prototype)", () => {
  it("should throw provider-mismatch for an intent whose provider is not gcp", async () => {
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: makeStubClient(),
      toSubjectToken: () => "jwt-placeholder",
    });
    const intent = makeIntent({
      target: { provider: "aws", providerAccountRef: "123456789012" },
    });
    await expect(
      ex.exchange(intent, {
        wifAudience: "audience",
        serviceAccountEmail: "sa@x.iam.gserviceaccount.com",
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    ).rejects.toMatchObject({ reason: "provider-mismatch" });
  });

  it("should throw context-missing when wifAudience is absent", async () => {
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: makeStubClient(),
      toSubjectToken: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        serviceAccountEmail: "sa@x.iam.gserviceaccount.com",
        oauthScopes: ["scope"],
      } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should throw context-missing when serviceAccountEmail is absent", async () => {
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: makeStubClient(),
      toSubjectToken: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        wifAudience: "audience",
        oauthScopes: ["scope"],
      } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should throw context-missing when oauthScopes is an empty array", async () => {
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: makeStubClient(),
      toSubjectToken: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        wifAudience: "//iam.googleapis.com/projects/123/...",
        serviceAccountEmail: "sa@x.iam.gserviceaccount.com",
        oauthScopes: [],
      }),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should call GCP STS then IAM Credentials in sequence and return a credential on the success path", async () => {
    let exchangeIn: GcpStsExchangeInput | undefined;
    let generateIn: GenerateServiceAccountTokenInput | undefined;
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: makeStubClient({
        onExchange: (i) => {
          exchangeIn = i;
        },
        onGenerate: (i) => {
          generateIn = i;
        },
      }),
      toSubjectToken: (intent) => `subject-token-for-${intent.requestId}`,
    });
    const result = await ex.exchange(makeIntent(), {
      wifAudience:
        "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/p/providers/cdk",
      serviceAccountEmail: "deploy-sa@tenkacloud.iam.gserviceaccount.com",
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    expect(exchangeIn?.audience).toContain("workloadIdentityPools/p");
    expect(exchangeIn?.subjectToken).toBe("subject-token-for-req-gcp-1");
    expect(exchangeIn?.subjectTokenType).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(exchangeIn?.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(generateIn?.federatedToken).toBe("federated-token-xyz");
    expect(generateIn?.serviceAccountEmail).toBe("deploy-sa@tenkacloud.iam.gserviceaccount.com");
    expect(generateIn?.lifetimeSeconds).toBe(1800);
    expect(result.provider).toBe("gcp");
    expect(result.accessToken).toBe("ya29.SA-access-token");
    expect(result.federatedToken).toBe("federated-token-xyz");
    expect(result.forRequestId).toBe("req-gcp-1");
  });

  it("should wrap a GCP STS throw into provider-api-error", async () => {
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: {
        exchangeToken: async () => {
          throw new Error("GCP STS 5xx");
        },
        generateServiceAccountToken: async () => {
          throw new Error("should not reach");
        },
      },
      toSubjectToken: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        wifAudience: "audience",
        serviceAccountEmail: "sa@x.iam.gserviceaccount.com",
        oauthScopes: ["s"],
      }),
    ).rejects.toBeInstanceOf(ExchangeError);
  });

  it("should wrap an IAM credentials API throw into provider-api-error after the federated step has completed", async () => {
    let federatedReached = false;
    const ex = new GcpWorkloadIdentityFederationExchange({
      stsClient: {
        exchangeToken: async () => {
          federatedReached = true;
          return { access_token: "f-tok", expires_in: 3600 };
        },
        generateServiceAccountToken: async () => {
          throw new Error("IAM API 403");
        },
      },
      toSubjectToken: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        wifAudience: "a",
        serviceAccountEmail: "sa@x.iam.gserviceaccount.com",
        oauthScopes: ["s"],
      }),
    ).rejects.toMatchObject({ reason: "provider-api-error" });
    expect(federatedReached).toBe(true);
  });
});
