import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CLOCK_TOLERANCE_SEC,
  type Jwk,
  type JwksResolver,
  verifyOidcJwt,
} from "../src/oidc-jwks-verify";

/**
 * Issue #2292: offline matrix for the generic OIDC/JWKS verifier.
 *
 * Keypairs are generated in-test via WebCrypto (RSASSA-PKCS1-v1_5); a tiny in-test
 * signer produces compact JWTs so every branch — valid, each failure reason, and the
 * clock-tolerance boundary — is exercised without any network or real Auth0.
 */

const ISSUER = "https://tenant.us.auth0.com/";
const AUDIENCE = "https://workers-control-api.tenkacloud.dev";
const KID = "auth0-key-1";
const FAR_FUTURE_EXP = 4102444800; // 2100-01-01T00:00:00Z, seconds
const SIGN_ALG = { name: "RSASSA-PKCS1-v1_5" } as const;
const TEXT = new TextEncoder();

interface KeyMaterial {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Jwk;
}

async function generateKeyMaterial(hash: string, kid: string): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { ...exported, kid } };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(TEXT.encode(text));
}

/** Sign already-encoded segments — lets tests forge non-object payloads with a valid signature. */
async function signSegments(
  privateKey: CryptoKey,
  headerSegment: string,
  payloadSegment: string,
): Promise<string> {
  const signingInput = TEXT.encode(`${headerSegment}.${payloadSegment}`);
  const signature = await crypto.subtle.sign(SIGN_ALG, privateKey, signingInput);
  return `${headerSegment}.${payloadSegment}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  return signSegments(
    privateKey,
    textToBase64Url(JSON.stringify(header)),
    textToBase64Url(JSON.stringify(claims)),
  );
}

function resolverFor(...jwks: Jwk[]): JwksResolver {
  return async (kid) => jwks.find((jwk) => jwk.kid === kid);
}

let rs256: KeyMaterial;
let resolver: JwksResolver;

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: "RS256", typ: "JWT", kid: KID, ...overrides };
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "auth0|organizer-1",
    exp: FAR_FUTURE_EXP,
    nbf: 0,
    "https://tenkacloud.dev/roles": ["organizer"],
    ...overrides,
  };
}

const options = (overrides: Partial<Parameters<typeof verifyOidcJwt>[1]> = {}) => ({
  jwksResolver: resolver,
  issuer: ISSUER,
  audience: AUDIENCE,
  ...overrides,
});

beforeAll(async () => {
  rs256 = await generateKeyMaterial("SHA-256", KID);
  resolver = resolverFor(rs256.publicJwk);
});

describe("verifyOidcJwt", () => {
  it("should accept a valid token and return its claims and header", async () => {
    const token = await signJwt(rs256.privateKey, header(), claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.claims.sub).toBe("auth0|organizer-1");
      expect(outcome.claims["https://tenkacloud.dev/roles"]).toEqual(["organizer"]);
      expect(outcome.header.alg).toBe("RS256");
      expect(outcome.header.kid).toBe(KID);
    }
  });

  it("should accept a token with no exp and no nbf (temporal checks skipped)", async () => {
    const { exp: _exp, nbf: _nbf, ...rest } = claims();
    const token = await signJwt(rs256.privateKey, header(), rest);
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(true);
  });

  it("should accept an array aud that contains the expected audience", async () => {
    const token = await signJwt(
      rs256.privateKey,
      header(),
      claims({ aud: ["https://other.example", AUDIENCE] }),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(true);
  });

  it("should accept RS384 signed tokens", async () => {
    const material = await generateKeyMaterial("SHA-384", "rs384-key");
    const token = await signJwt(
      material.privateKey,
      header({ alg: "RS384", kid: "rs384-key" }),
      claims(),
    );
    const outcome = await verifyOidcJwt(
      token,
      options({ jwksResolver: resolverFor(material.publicJwk) }),
    );
    expect(outcome.valid).toBe(true);
  });

  it("should accept RS512 signed tokens", async () => {
    const material = await generateKeyMaterial("SHA-512", "rs512-key");
    const token = await signJwt(
      material.privateKey,
      header({ alg: "RS512", kid: "rs512-key" }),
      claims(),
    );
    const outcome = await verifyOidcJwt(
      token,
      options({ jwksResolver: resolverFor(material.publicJwk) }),
    );
    expect(outcome.valid).toBe(true);
  });

  it("should return token-expired when exp is in the past beyond tolerance", async () => {
    const now = () => new Date("2026-07-04T00:00:00.000Z");
    const nowSec = Math.floor(now().getTime() / 1000);
    const token = await signJwt(rs256.privateKey, header(), claims({ exp: nowSec - 3600 }));
    const outcome = await verifyOidcJwt(token, options({ now }));
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("token-expired");
  });

  it("should return token-not-yet-valid when nbf is in the future beyond tolerance", async () => {
    const now = () => new Date("2026-07-04T00:00:00.000Z");
    const nowSec = Math.floor(now().getTime() / 1000);
    const token = await signJwt(
      rs256.privateKey,
      header(),
      claims({ nbf: nowSec + 3600, exp: nowSec + 7200 }),
    );
    const outcome = await verifyOidcJwt(token, options({ now }));
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("token-not-yet-valid");
  });

  it("should let a just-expired token pass when within clockToleranceSec", async () => {
    const now = () => new Date("2026-07-04T00:00:00.000Z");
    const nowSec = Math.floor(now().getTime() / 1000);
    const token = await signJwt(rs256.privateKey, header(), claims({ exp: nowSec - 30 }));
    const outcome = await verifyOidcJwt(token, options({ now, clockToleranceSec: 60 }));
    expect(outcome.valid).toBe(true);
  });

  it("should return issuer-mismatch when iss does not equal the expected issuer", async () => {
    const token = await signJwt(
      rs256.privateKey,
      header(),
      claims({ iss: "https://evil.example/" }),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("issuer-mismatch");
  });

  it("should return issuer-mismatch when iss is missing", async () => {
    const { iss: _iss, ...rest } = claims();
    const token = await signJwt(rs256.privateKey, header(), rest);
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("issuer-mismatch");
  });

  it("should return audience-mismatch when a string aud does not match", async () => {
    const token = await signJwt(
      rs256.privateKey,
      header(),
      claims({ aud: "https://other.example" }),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("audience-mismatch");
  });

  it("should return audience-mismatch when an array aud does not contain the audience", async () => {
    const token = await signJwt(
      rs256.privateKey,
      header(),
      claims({ aud: ["https://a.example", "https://b.example"] }),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("audience-mismatch");
  });

  it("should return audience-mismatch when aud is missing", async () => {
    const { aud: _aud, ...rest } = claims();
    const token = await signJwt(rs256.privateKey, header(), rest);
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("audience-mismatch");
  });

  it("should return signature-invalid when the payload is tampered after signing", async () => {
    const token = await signJwt(rs256.privateKey, header(), claims());
    const [headerSegment, , signatureSegment] = token.split(".");
    const forgedPayload = textToBase64Url(JSON.stringify(claims({ sub: "auth0|attacker" })));
    const tampered = `${headerSegment}.${forgedPayload}.${signatureSegment}`;
    const outcome = await verifyOidcJwt(tampered, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("signature-invalid");
  });

  it("should return signature-invalid when signed by a different key", async () => {
    const other = await generateKeyMaterial("SHA-256", KID);
    const token = await signJwt(other.privateKey, header(), claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("signature-invalid");
  });

  it("should return signature-invalid when the signature segment is not valid base64url", async () => {
    const token = await signJwt(rs256.privateKey, header(), claims());
    const [headerSegment, payloadSegment] = token.split(".");
    const outcome = await verifyOidcJwt(`${headerSegment}.${payloadSegment}.@@@`, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("signature-invalid");
  });

  it("should return key-not-found when the resolver has no key for the kid", async () => {
    const token = await signJwt(rs256.privateKey, header({ kid: "unknown-kid" }), claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("key-not-found");
  });

  it("should return missing-kid when the header has no kid", async () => {
    const { kid: _kid, ...noKid } = header();
    const token = await signJwt(rs256.privateKey, noKid, claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("missing-kid");
  });

  it("should return unsupported-algorithm for an HS256 token", async () => {
    const token = await signJwt(rs256.privateKey, header({ alg: "HS256" }), claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("unsupported-algorithm");
  });

  it("should return unsupported-algorithm for an alg:none token", async () => {
    const token = await signJwt(rs256.privateKey, header({ alg: "none" }), claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("unsupported-algorithm");
  });

  it("should return unsupported-algorithm when the header has no alg", async () => {
    const { alg: _alg, ...noAlg } = header();
    const token = await signJwt(rs256.privateKey, noAlg, claims());
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("unsupported-algorithm");
  });

  it("should return malformed-token when the token does not have three segments", async () => {
    const outcome = await verifyOidcJwt("only.two", options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("malformed-token");
  });

  it("should return malformed-token when the header segment is not valid base64url", async () => {
    const outcome = await verifyOidcJwt("@@@.payload.sig", options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("malformed-token");
  });

  it("should return malformed-token when the header decodes to a non-object", async () => {
    const outcome = await verifyOidcJwt(`${textToBase64Url("42")}.payload.sig`, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("malformed-token");
  });

  it("should return claims-parse-failed when a validly-signed payload is not JSON", async () => {
    const token = await signSegments(
      rs256.privateKey,
      textToBase64Url(JSON.stringify(header())),
      textToBase64Url("{not json"),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("claims-parse-failed");
  });

  it("should return claims-parse-failed when a validly-signed payload is a JSON array", async () => {
    const token = await signSegments(
      rs256.privateKey,
      textToBase64Url(JSON.stringify(header())),
      textToBase64Url("[]"),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("claims-parse-failed");
  });

  it("should return claims-parse-failed when a validly-signed payload is JSON null", async () => {
    const token = await signSegments(
      rs256.privateKey,
      textToBase64Url(JSON.stringify(header())),
      textToBase64Url("null"),
    );
    const outcome = await verifyOidcJwt(token, options());
    expect(outcome.valid).toBe(false);
    if (!outcome.valid) expect(outcome.reason).toBe("claims-parse-failed");
  });

  it("should expose DEFAULT_CLOCK_TOLERANCE_SEC as 60", () => {
    expect(DEFAULT_CLOCK_TOLERANCE_SEC).toBe(60);
  });
});
