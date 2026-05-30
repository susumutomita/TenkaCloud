import { createHmac, randomBytes } from "node:crypto";
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

/** base64url without padding — matches jws.ts encoding. */
function b64url(input: string | Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a JWS-shaped token from an arbitrary header object + raw payload string,
 * signing `header.payload` with `secret` so the HMAC check passes. Lets the tests
 * reach verifySignature failure branches that `signIntent` (which always emits a
 * valid HS256 header and JSON payload) cannot produce.
 */
function craftToken(header: unknown, payload: string, secret: Uint8Array): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(payload);
  const sig = b64url(new Uint8Array(createHmac("sha256", secret).update(`${h}.${p}`).digest()));
  return `${h}.${p}.${sig}`;
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

  it("should map a token without three segments to jws-malformed", async () => {
    const result = await verifyIntent("only.two", { resolveSecret: () => randomBytes(32) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-malformed");
  });

  it("should map a header with typ != JWS to jws-malformed", async () => {
    const secret = randomBytes(32);
    const token = craftToken({ alg: "HS256", typ: "NOPE" }, JSON.stringify(intent()), secret);
    const result = await verifyIntent(token, { resolveSecret: () => secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-malformed");
  });

  it("should map a non-JSON header to jws-malformed", async () => {
    const token = `${b64url("not-json{")}.${b64url("{}")}.${b64url("sig")}`;
    const result = await verifyIntent(token, { resolveSecret: () => randomBytes(32) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-malformed");
  });

  it("should map an unsupported alg to jws-unknown-algorithm", async () => {
    const secret = randomBytes(32);
    const token = craftToken({ alg: "RS256", typ: "JWS" }, JSON.stringify(intent()), secret);
    const result = await verifyIntent(token, { resolveSecret: () => secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-unknown-algorithm");
  });

  it("should map an unresolved secret to jws-secret-not-resolved", async () => {
    const token = signIntent(intent(), { secret: randomBytes(32) });
    const result = await verifyIntent(token, { resolveSecret: () => undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-secret-not-resolved");
  });

  it("should map a non-JSON payload with a valid signature to jws-payload-parse-failed", async () => {
    const secret = randomBytes(32);
    const token = craftToken({ alg: "HS256", typ: "JWS" }, "not-json{", secret);
    const result = await verifyIntent(token, { resolveSecret: () => secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jws-payload-parse-failed");
  });

  it("should default `now` to the current time when the option is omitted", async () => {
    const secret = randomBytes(32);
    // Far-future expiry so the real wall-clock default stays valid regardless of run date.
    const token = signIntent(intent({ expiresAt: "2999-01-01T00:00:00.000Z" }), { secret });
    const result = await verifyIntent(token, { resolveSecret: () => secret });
    expect(result.ok).toBe(true);
  });

  it("should proceed to ok=true when the nonce store accepts the nonce", async () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const acceptStore: NonceStore = { recordNonce: async () => "accepted" };
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
      nonceStore: acceptStore,
    });
    expect(result.ok).toBe(true);
  });

  it("should accept a token whose notBefore is already in the past", async () => {
    const secret = randomBytes(32);
    const token = signIntent(
      intent({ notBefore: "2026-05-15T18:00:00.000Z", expiresAt: "2026-05-15T22:00:00.000Z" }),
      { secret },
    );
    const result = await verifyIntent(token, {
      resolveSecret: () => secret,
      now: () => new Date("2026-05-15T19:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
  });
});
