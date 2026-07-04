import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { auth0JwtMiddleware } from "../src/auth.js";
import type { AppEnvironment } from "../src/types.js";

const KID = "auth0-key-1";
const SIGN_ALGORITHM = { name: "RSASSA-PKCS1-v1_5" } as const;
const TEXT_ENCODER = new TextEncoder();
const FAR_FUTURE_EXPIRY = 4_102_444_800;

interface KeyMaterial {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: SIGN_ALGORITHM.name,
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicJwk: { ...publicJwk, kid: KID },
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(TEXT_ENCODER.encode(text));
}

async function signJwt(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const headerSegment = textToBase64Url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payloadSegment = textToBase64Url(JSON.stringify(claims));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await crypto.subtle.sign(
    SIGN_ALGORITHM,
    privateKey,
    TEXT_ENCODER.encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: env.AUTH0_ISSUER,
    aud: env.AUTH0_AUDIENCE,
    sub: "auth0|organizer",
    org_id: "org_acme",
    exp: FAR_FUTURE_EXPIRY,
    ...overrides,
  };
}

function createJwtApp(fetchImpl: typeof fetch): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  app.use("*", auth0JwtMiddleware({ fetchImpl }));
  app.get("/", (context) => context.text(JSON.stringify(context.get("jwtPayload"))));
  return app;
}

function authorizedRequest(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

let trustedKey: KeyMaterial;
let untrustedKey: KeyMaterial;
let jwksFetch: ReturnType<typeof vi.fn>;
let fetchImpl: typeof fetch;

beforeAll(async () => {
  [trustedKey, untrustedKey] = await Promise.all([generateKeyMaterial(), generateKeyMaterial()]);
  jwksFetch = vi.fn(async () => {
    return new Response(JSON.stringify({ keys: [trustedKey.publicJwk] }), {
      status: StatusCodes.OK,
      headers: { "content-type": "application/json" },
    });
  });
  fetchImpl = jwksFetch as typeof fetch;
});

describe("auth0JwtMiddleware", () => {
  it("should verify a valid token, expose its claims downstream, and reuse the JWKS cache", async () => {
    const app = createJwtApp(fetchImpl);
    const expectedClaims = claims();
    const token = await signJwt(trustedKey.privateKey, expectedClaims);

    const first = await app.request("/", authorizedRequest(token), env);
    const second = await app.request("/", authorizedRequest(token), env);

    expect(first.status).toBe(StatusCodes.OK);
    await expect(first.json()).resolves.toEqual(expectedClaims);
    expect(second.status).toBe(StatusCodes.OK);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(jwksFetch).toHaveBeenCalledWith(
      `${env.AUTH0_ISSUER.replace(/\/+$/u, "")}/.well-known/jwks.json`,
    );
  });

  it("should reject a missing or malformed Authorization header", async () => {
    const app = createJwtApp(fetchImpl);

    const missing = await app.request("/", undefined, env);
    const malformed = await app.request("/", { headers: { authorization: "Basic token" } }, env);

    expect(missing.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(malformed.status).toBe(StatusCodes.UNAUTHORIZED);
  });

  it("should reject a token signed by a different key", async () => {
    const token = await signJwt(untrustedKey.privateKey, claims());
    const response = await createJwtApp(fetchImpl).request("/", authorizedRequest(token), env);

    expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
    await expect(response.text()).resolves.toBe("invalid access token");
  });

  it("should reject an expired token", async () => {
    const token = await signJwt(trustedKey.privateKey, claims({ exp: 0 }));
    const response = await createJwtApp(fetchImpl).request("/", authorizedRequest(token), env);

    expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
  });

  it("should reject a token with the wrong audience or issuer", async () => {
    const wrongAudience = await signJwt(
      trustedKey.privateKey,
      claims({ aud: "https://wrong-audience.example" }),
    );
    const wrongIssuer = await signJwt(
      trustedKey.privateKey,
      claims({ iss: "https://wrong-issuer.example/" }),
    );
    const app = createJwtApp(fetchImpl);

    const audienceResponse = await app.request("/", authorizedRequest(wrongAudience), env);
    const issuerResponse = await app.request("/", authorizedRequest(wrongIssuer), env);

    expect(audienceResponse.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(issuerResponse.status).toBe(StatusCodes.UNAUTHORIZED);
  });
});
