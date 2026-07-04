import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signIntent, verifySignature } from "../src/jws.js";
import { type CloudActionIntent, INTENT_VERSION } from "../src/schema.js";

function intent(): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-101",
    nonce: "nonce-jws-1",
    source: { system: "tenkacloud", tenantId: "t-1", workloadId: "w-1" },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cfn:CreateStack"],
    },
    constraints: {
      ttlSeconds: 600,
      expiresAt: "2026-05-15T18:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
  };
}

describe("JWS HS256 sign / verify (#795 Phase 1)", () => {
  it("should sign with the correct secret, verify successfully, and recover the original intent", () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const result = verifySignature(token, { resolveSecret: () => secret });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.requestId).toBe("req-101");
      expect(result.header.alg).toBe("HS256");
    }
  });

  it("should return malformed-token when the token format is broken", () => {
    const result = verifySignature("not.a.token.extra", {
      resolveSecret: () => new Uint8Array(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-token");
  });

  it("should return malformed-token when the protected header is not JSON", () => {
    const malformedHeader = Buffer.from("{").toString("base64url");
    const result = verifySignature(`${malformedHeader}.e30.c2ln`, {
      resolveSecret: () => randomBytes(32),
    });

    expect(result).toEqual({ ok: false, reason: "malformed-token" });
  });

  it("should return secret-not-resolved when the secret cannot be resolved", () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const result = verifySignature(token, { resolveSecret: () => undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("secret-not-resolved");
  });

  it("should return signature-mismatch when verifying with a different secret", () => {
    const signer = randomBytes(32);
    const verifier = randomBytes(32);
    const token = signIntent(intent(), { secret: signer });
    const result = verifySignature(token, { resolveSecret: () => verifier });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature-mismatch");
  });

  it("should return unknown-algorithm for a token whose header carries an unknown alg", () => {
    const secret = randomBytes(32);
    const token = signIntent(intent(), { secret });
    const [, payload, sig] = token.split(".");
    // header だけ書き換えて再送 (= signature は壊れるが、 そもそも alg check が先)
    const fakeHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWS" })).toString(
      "base64url",
    );
    const tampered = `${fakeHeader}.${payload}.${sig}`;
    const result = verifySignature(tampered, { resolveSecret: () => secret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown-algorithm");
  });

  it("should put kid from options into the header and pass it to resolveSecret", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const token = signIntent(intent(), { secret: k1, kid: "key-1" });
    const result = verifySignature(token, {
      resolveSecret: (h: { kid?: string }) => (h.kid === "key-1" ? k1 : k2),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.header.kid).toBe("key-1");
  });
});
