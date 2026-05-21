import { describe, expect, it } from "vitest";
import {
  AzureFederatedCredentialExchange,
  type AzureTokenEndpointClient,
  type AzureTokenExchangeInput,
} from "../src/azure-federated-credential.js";
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
    requestId: "req-azure-1",
    nonce: "nonce-azure-1",
    source: { system: "tenkacloud", tenantId: "tenant-y", workloadId: "w-1" },
    target: { provider: "azure", providerAccountRef: "00000000-0000-0000-0000-000000000001" },
    action: {
      type: "deploy",
      engine: "bicep",
      requestedScopes: ["microsoft.compute/virtualmachines/write"],
    },
    constraints: {
      ttlSeconds: 1200,
      expiresAt: "2026-05-16T00:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  });
}

function makeStub(capture?: (input: AzureTokenExchangeInput) => void): AzureTokenEndpointClient {
  return {
    exchangeAssertion: async (input) => {
      capture?.(input);
      return {
        access_token: "eyJ-az-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      };
    },
  };
}

describe("AzureFederatedCredentialExchange (#795 Phase 4 prototype)", () => {
  it("should throw provider-mismatch for an intent whose provider is not azure", async () => {
    const ex = new AzureFederatedCredentialExchange({
      tokenClient: makeStub(),
      toClientAssertion: () => "jwt",
    });
    const intent = makeIntent({
      target: { provider: "aws", providerAccountRef: "111111111111" },
    });
    await expect(
      ex.exchange(intent, {
        azureTenantId: "tid",
        clientId: "cid",
        scope: "https://management.azure.com/.default",
      }),
    ).rejects.toMatchObject({ reason: "provider-mismatch" });
  });

  it("should throw context-missing when azureTenantId is absent", async () => {
    const ex = new AzureFederatedCredentialExchange({
      tokenClient: makeStub(),
      toClientAssertion: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        clientId: "cid",
        scope: "https://management.azure.com/.default",
      } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should also throw context-missing when clientId or scope is absent", async () => {
    const ex = new AzureFederatedCredentialExchange({
      tokenClient: makeStub(),
      toClientAssertion: () => "jwt",
    });
    await expect(
      ex.exchange(makeIntent(), {
        azureTenantId: "tid",
        clientId: "",
        scope: "x",
      } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
    await expect(
      ex.exchange(makeIntent(), {
        azureTenantId: "tid",
        clientId: "cid",
        scope: "",
      } as Record<string, unknown>),
    ).rejects.toMatchObject({ reason: "context-missing" });
  });

  it("should pass client_assertion / scope to the AzureAD endpoint and normalize expires_in to ISO on the success path", async () => {
    let captured: AzureTokenExchangeInput | undefined;
    const fixedNow = new Date("2026-05-15T22:00:00.000Z");
    const ex = new AzureFederatedCredentialExchange({
      tokenClient: makeStub((i) => {
        captured = i;
      }),
      now: () => fixedNow,
      toClientAssertion: (intent) => `assertion-for-${intent.requestId}`,
    });
    const result = await ex.exchange(makeIntent(), {
      azureTenantId: "00000000-tenant-0000-0000-000000000000",
      clientId: "11111111-app-id",
      scope: "https://management.azure.com/.default",
    });
    expect(captured?.tenantId).toBe("00000000-tenant-0000-0000-000000000000");
    expect(captured?.clientId).toBe("11111111-app-id");
    expect(captured?.clientAssertion).toBe("assertion-for-req-azure-1");
    expect(captured?.scope).toBe("https://management.azure.com/.default");
    expect(result.provider).toBe("azure");
    expect(result.accessToken).toBe("eyJ-az-access-token");
    expect(result.tokenType).toBe("Bearer");
    expect(result.clientId).toBe("11111111-app-id");
    // issuedAt=22:00、 expires_in=3600 → expiresAt=23:00
    expect(result.expiresAt).toBe("2026-05-15T23:00:00.000Z");
    expect(result.forRequestId).toBe("req-azure-1");
  });

  it("should wrap an Azure AD endpoint throw into provider-api-error", async () => {
    const ex = new AzureFederatedCredentialExchange({
      tokenClient: {
        exchangeAssertion: async () => {
          throw new Error("AADSTS70021");
        },
      },
      toClientAssertion: () => "jwt",
    });
    try {
      await ex.exchange(makeIntent(), {
        azureTenantId: "tid",
        clientId: "cid",
        scope: "scope",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExchangeError);
      const ee = err as ExchangeError;
      expect(ee.reason).toBe("provider-api-error");
      expect((ee.underlying as Error).message).toBe("AADSTS70021");
    }
  });
});
