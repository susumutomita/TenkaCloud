import { describe, expect, it } from "vitest";
import { type DdbConditionalPutInput, DdbNonceStore } from "../src/ddb-nonce-store.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function intent(overrides: Partial<CloudActionIntent> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-1",
    nonce: "nonce-abc",
    source: { system: "tenkacloud", tenantId: "t-acme", workloadId: "w-1" },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: { type: "deploy", engine: "cloudformation", requestedScopes: ["cfn:CreateStack"] },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
    ...overrides,
  };
}

class ConditionalCheckFailed extends Error {
  override readonly name = "ConditionalCheckFailedException";
}

function recordingClient(behavior: () => Promise<void> = async () => {}) {
  const calls: DdbConditionalPutInput[] = [];
  return {
    calls,
    putItem: async (input: DdbConditionalPutInput) => {
      calls.push(input);
      return behavior();
    },
  };
}

describe("DdbNonceStore", () => {
  it("should accept a first-seen nonce via a conditional put", async () => {
    const client = recordingClient();
    const store = new DdbNonceStore({ client, tableName: "Nonces" });
    expect(await store.recordNonce(intent())).toBe("accepted");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      TableName: "Nonces",
      ConditionExpression: "attribute_not_exists(PK)",
    });
  });

  it("should scope the PK by tenant + requestId + nonce", async () => {
    const client = recordingClient();
    const store = new DdbNonceStore({ client, tableName: "Nonces" });
    await store.recordNonce(intent({ requestId: "r2", nonce: "n2" }));
    expect(client.calls[0].Item.PK).toBe("t-acme#r2#n2");
    expect(client.calls[0].Item).toMatchObject({
      requestId: "r2",
      nonce: "n2",
      tenantId: "t-acme",
    });
  });

  it("should set a DynamoDB TTL of expiresAt + grace (epoch seconds)", async () => {
    const client = recordingClient();
    const store = new DdbNonceStore({ client, tableName: "Nonces", ttlGraceSeconds: 60 });
    await store.recordNonce(intent());
    // 2026-05-15T20:00:00Z = 1778529600 epoch sec; + 60 grace.
    expect(client.calls[0].Item.expiresAt).toBe(
      Math.floor(Date.parse("2026-05-15T20:00:00.000Z") / 1000) + 60,
    );
  });

  it("should default the TTL grace to 300 seconds", async () => {
    const client = recordingClient();
    const store = new DdbNonceStore({ client, tableName: "Nonces" });
    await store.recordNonce(intent());
    expect(client.calls[0].Item.expiresAt).toBe(
      Math.floor(Date.parse("2026-05-15T20:00:00.000Z") / 1000) + 300,
    );
  });

  it("should report replay when the conditional put fails (nonce already present)", async () => {
    const client = recordingClient(async () => {
      throw new ConditionalCheckFailed("exists");
    });
    const store = new DdbNonceStore({ client, tableName: "Nonces" });
    expect(await store.recordNonce(intent())).toBe("replay");
  });

  it("should rethrow unexpected errors instead of swallowing them", async () => {
    const client = recordingClient(async () => {
      throw new Error("ProvisionedThroughputExceededException");
    });
    const store = new DdbNonceStore({ client, tableName: "Nonces" });
    await expect(store.recordNonce(intent())).rejects.toThrow(/ProvisionedThroughputExceeded/);
  });
});
