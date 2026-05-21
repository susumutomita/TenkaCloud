import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signIntent } from "../src/jws.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";
import { type NonceStore, verifyIntent } from "../src/verify.js";

function intent(overrides: Partial<CloudActionIntent["constraints"]> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-v-1",
    nonce: `nonce-${Math.random()}`,
    source: { system: "tenkacloud", tenantId: "t-1", workloadId: "w-1" },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cfn:CreateStack"],
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T20:00:00.000Z",
      allowPrivilegeEscalation: false,
      ...overrides,
    },
  };
}

describe("verifyIntent (#795 Phase 1)", () => {
  it("should return ok=true with a branded type for a valid token, future expiresAt, and unused nonce", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.requestId).toBe("req-v-1");
    }
  });

  it("should return expired when expiresAt is in the past relative to now", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent({ expiresAt: "2026-05-15T10:00:00.000Z" }), { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("should return not-yet-valid when notBefore is in the future relative to now", async () => {
    const secret = randomBytes(32);
    const token = signIntent(
      intent({
        notBefore: "2026-05-15T21:00:00.000Z",
        expiresAt: "2026-05-15T22:00:00.000Z",
      }),
      { secret },
    );
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T20:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-yet-valid");
  });

  it("should return nonce-replay when the nonce store reports replay (= defends against replay attacks)", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const replayStore: NonceStore = {
      recordNonce: async () => "replay",
    };
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      nonceStore: replayStore,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nonce-replay");
  });

  it("should pass verify when the nonce store reports accepted", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    let recorded = 0;
    const store: NonceStore = {
      recordNonce: async () => {
        recorded += 1;
        return "accepted";
      },
    };
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      nonceStore: store,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    expect(recorded).toBe(1);
  });

  it("should return schema-invalid for a payload that violates the schema (= contains unwanted properties)", async () => {
    const secret = randomBytes(32);
    // 直接 invalid payload を sign したいので、 schema を bypass して任意 object を渡す。
    const badPayload = {
      ...intent(),
      somethingExtra: "boom",
    } as unknown as CloudActionIntent;
    const token = signIntent(badPayload, { secret });
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
      expect(result.details?.length).toBeGreaterThan(0);
    }
  });

  it("should return jws-signature-mismatch when the signature has been tampered with", async () => {
    const signer = randomBytes(32);
    const verifier = randomBytes(32);
    const token = signIntent(intent(), { secret: signer });
    const result = await verifyIntent(token, {
      resolveSecret: () => verifier,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-signature-mismatch");
  });
});
