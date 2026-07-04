import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, signIntent } from "../src/jws.js";
import { signIntentEs256, verifySignatureEs256 } from "../src/jws-es256.js";
import { type CloudActionIntent, canonicalize, INTENT_VERSION } from "../src/schema.js";

type JsonWebKey = webcrypto.JsonWebKey;

function intent(): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: "req-es256-1",
    nonce: "nonce-es256-1",
    source: { system: "tenkacloud", tenantId: "tenant-a", workloadId: "worker" },
    target: { provider: "aws", providerAccountRef: "111111111111" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
    },
    constraints: {
      ttlSeconds: 300,
      expiresAt: "2999-01-01T00:00:00.000Z",
      allowPrivilegeEscalation: false,
    },
  };
}

async function keyPair(): Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

async function signedToken(
  header: unknown,
  payload: string,
  privateJwk: JsonWebKey,
): Promise<string> {
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

describe("ES256 JWS", () => {
  it("should sign and verify a canonical intent with a raw P-256 signature", async () => {
    const keys = await keyPair();
    const token = await signIntentEs256(intent(), {
      privateKey: keys.privateKey,
      kid: "key-2026-07",
    });
    const signature = base64urlDecode(token.split(".")[2] ?? "");
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: async (header) => {
        expect(header.kid).toBe("key-2026-07");
        return keys.publicKey;
      },
    });

    expect(signature).toHaveLength(64);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.intent).toEqual(intent());
      expect(outcome.header).toEqual({
        alg: "ES256",
        typ: "JWS",
        kid: "key-2026-07",
      });
      expect(new TextDecoder().decode(base64urlDecode(token.split(".")[1] ?? ""))).toBe(
        canonicalize(intent()),
      );
    }
  });

  it("should omit kid when none is supplied", async () => {
    const keys = await keyPair();
    const token = await signIntentEs256(intent(), { privateKey: keys.privateKey });
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: () => keys.publicKey,
    });

    expect(outcome.ok && outcome.header.kid).toBeUndefined();
  });

  it("should reject a signature verified with a different public key", async () => {
    const signer = await keyPair();
    const verifier = await keyPair();
    const token = await signIntentEs256(intent(), { privateKey: signer.privateKey });
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: () => verifier.publicKey,
    });

    expect(outcome).toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("should reject tampered payload and signature bytes", async () => {
    const keys = await keyPair();
    const token = await signIntentEs256(intent(), { privateKey: keys.privateKey });
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = `${header}.${payload}A.${signature}`;
    const signatureBytes = base64urlDecode(signature ?? "");
    signatureBytes[0] ^= 1;
    const tamperedSignature = `${header}.${payload}.${base64urlEncode(signatureBytes)}`;

    await expect(
      verifySignatureEs256(tamperedPayload, {
        resolvePublicKey: () => keys.publicKey,
      }),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifySignatureEs256(tamperedSignature, {
        resolvePublicKey: () => keys.publicKey,
      }),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("should reject an HS256 token as an unknown algorithm", async () => {
    const token = signIntent(intent(), {
      secret: new TextEncoder().encode("rollback-secret"),
    });
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: () => undefined,
    });

    expect(outcome).toEqual({ ok: false, reason: "unknown-algorithm" });
  });

  it("should reject malformed compact tokens and headers", async () => {
    const keys = await keyPair();
    await expect(
      verifySignatureEs256("only.two", {
        resolvePublicKey: () => keys.publicKey,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed-token" });

    const invalidJsonHeader = `${base64urlEncode(new TextEncoder().encode("{"))}.e30.c2ln`;
    await expect(
      verifySignatureEs256(invalidJsonHeader, {
        resolvePublicKey: () => keys.publicKey,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed-token" });

    const wrongTyp = await signedToken(
      { alg: "ES256", typ: "JWT" },
      JSON.stringify(intent()),
      keys.privateKey,
    );
    await expect(
      verifySignatureEs256(wrongTyp, {
        resolvePublicKey: () => keys.publicKey,
      }),
    ).resolves.toEqual({ ok: false, reason: "malformed-token" });
  });

  it("should fail when the public key cannot be resolved", async () => {
    const keys = await keyPair();
    const token = await signIntentEs256(intent(), { privateKey: keys.privateKey });
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: () => undefined,
    });

    expect(outcome).toEqual({ ok: false, reason: "secret-not-resolved" });
  });

  it("should reject a non-JSON payload after verifying its signature", async () => {
    const keys = await keyPair();
    const token = await signedToken({ alg: "ES256", typ: "JWS" }, "not-json{", keys.privateKey);
    const outcome = await verifySignatureEs256(token, {
      resolvePublicKey: () => keys.publicKey,
    });

    expect(outcome).toEqual({ ok: false, reason: "payload-parse-failed" });
  });
});
