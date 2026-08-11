import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCachingJwksResolver, DEFAULT_CACHE_TTL_SEC } from "../src/jwks-resolver";
import { type Jwk, verifyOidcJwt } from "../src/oidc-jwks-verify";

/**
 * Issue #2292: offline matrix for the caching JWKS resolver.
 *
 * Keypairs are generated in-test via WebCrypto (RSASSA-PKCS1-v1_5) and their public
 * JWKs are served through a fake `fetchImpl`, so caching / TTL / rotation / dedup and
 * the fail-closed error paths are all exercised without any network or real Auth0.
 * The final case feeds the resolver into the REAL `verifyOidcJwt` to prove the shape
 * satisfies the verifier's contract.
 */

const JWKS_URI = "https://tenant.us.auth0.com/.well-known/jwks.json";
const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const ISSUER = "https://tenant.us.auth0.com/";
const AUDIENCE = "https://workers-control-api.tenkacloud.dev";
const FAR_FUTURE_EXP = 4102444800; // 2100-01-01T00:00:00Z, seconds
const SIGN_ALG = { name: "RSASSA-PKCS1-v1_5" } as const;
const TEXT = new TextEncoder();

interface KeyMaterial {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Jwk;
}

async function generateKeyMaterial(kid: string): Promise<KeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
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

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const headerSegment = textToBase64Url(JSON.stringify(header));
  const payloadSegment = textToBase64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    SIGN_ALG,
    privateKey,
    TEXT.encode(`${headerSegment}.${payloadSegment}`),
  );
  return `${headerSegment}.${payloadSegment}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

interface FakeResponseInit {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body: unknown;
}

/** A minimal `Response`-like the resolver reads via `.ok` / `.status` / `.json()`. */
function fakeResponse(init: FakeResponseInit): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? HTTP_OK,
    json: async () => init.body,
  } as unknown as Response;
}

/** A `fetchImpl` double that serves the given `keys` bodies in sequence (last repeats). */
function jwksFetch(...bodies: unknown[]): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return fakeResponse({ body });
  });
}

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

let jwkA: Jwk;
let jwkB: Jwk;
let jwkNoKid: Jwk;
let e2e: KeyMaterial;

beforeAll(async () => {
  const a = await generateKeyMaterial("a");
  const b = await generateKeyMaterial("b");
  e2e = await generateKeyMaterial("e2e");
  jwkA = a.publicJwk;
  jwkB = b.publicJwk;
  const { kid: _kid, ...withoutKid } = a.publicJwk;
  jwkNoKid = withoutKid as Jwk;
});

describe("createCachingJwksResolver", () => {
  it("should resolve the JWK for a present kid", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    expect(await resolve("a")).toEqual(jwkA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(JWKS_URI);
  });

  it("should return undefined for a kid absent from the JWKS", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    expect(await resolve("missing")).toBeUndefined();
  });

  it("should not refetch within the TTL when the kid is cached", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] });
    let nowMs = 0;
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      cacheTtlSec: 10,
      now: () => nowMs,
    });
    expect(await resolve("a")).toEqual(jwkA);
    nowMs = 9_999; // still < 10_000 ms TTL
    expect(await resolve("a")).toEqual(jwkA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should refetch after the TTL expires", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] });
    let nowMs = 0;
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      cacheTtlSec: 10,
      now: () => nowMs,
    });
    expect(await resolve("a")).toEqual(jwkA);
    nowMs = 10_000; // TTL boundary is exclusive → stale
    expect(await resolve("a")).toEqual(jwkA);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should refetch once when a fresh cache lacks the kid and return the rotated key", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] }, { keys: [jwkA, jwkB] });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      cacheTtlSec: 3600,
      now: () => 0, // cache stays fresh throughout
    });
    expect(await resolve("a")).toEqual(jwkA);
    expect(await resolve("b")).toEqual(jwkB); // rotation → one extra fetch
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should resolve undefined for an undefined kid without fetching", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkA] });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    expect(await resolve(undefined)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should dedupe concurrent cache misses into a single fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      await Promise.resolve();
      return fakeResponse({ body: { keys: [jwkA] } });
    });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    const [first, second] = await Promise.all([resolve("a"), resolve("a")]);
    expect(first).toEqual(jwkA);
    expect(second).toEqual(jwkA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should skip JWKS entries that have no kid", async () => {
    const fetchImpl = jwksFetch({ keys: [jwkNoKid, jwkA] });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    expect(await resolve("a")).toEqual(jwkA);
  });

  it("should reject when the JWKS endpoint returns a non-ok response", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: false, status: HTTP_SERVICE_UNAVAILABLE, body: undefined }),
    );
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    await expect(resolve("a")).rejects.toThrow(/JWKS fetch failed/);
  });

  it("should propagate a network error from fetch (fail closed)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    await expect(resolve("a")).rejects.toThrow(/network down/);
  });

  it("should reject when the JWKS body has no keys array", async () => {
    const fetchImpl = jwksFetch({ notKeys: true });
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    await expect(resolve("a")).rejects.toThrow(/malformed/);
  });

  it("should reject when the JWKS body is JSON null", async () => {
    const fetchImpl = jwksFetch(null);
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    await expect(resolve("a")).rejects.toThrow(/malformed/);
  });

  it("should reject when the JWKS body is not a JSON object", async () => {
    const fetchImpl = jwksFetch(42);
    const resolve = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    await expect(resolve("a")).rejects.toThrow(/malformed/);
  });

  it("should default to globalThis.fetch, Date.now, and the default TTL when unspecified", async () => {
    const stub = vi.fn(async () => fakeResponse({ body: { keys: [jwkA] } }));
    vi.stubGlobal("fetch", stub);
    try {
      const resolve = createCachingJwksResolver({ jwksUri: JWKS_URI });
      expect(await resolve("a")).toEqual(jwkA);
      expect(stub).toHaveBeenCalledWith(JWKS_URI);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should expose DEFAULT_CACHE_TTL_SEC as 3600", () => {
    expect(DEFAULT_CACHE_TTL_SEC).toBe(3600);
  });

  it("should satisfy verifyOidcJwt end-to-end with an in-test-signed RS256 token", async () => {
    const fetchImpl = jwksFetch({ keys: [e2e.publicJwk] });
    const jwksResolver = createCachingJwksResolver({
      jwksUri: JWKS_URI,
      fetchImpl: asFetch(fetchImpl),
      now: () => 0,
    });
    const token = await signJwt(
      e2e.privateKey,
      { alg: "RS256", typ: "JWT", kid: "e2e" },
      { iss: ISSUER, aud: AUDIENCE, sub: "auth0|organizer-1", exp: FAR_FUTURE_EXP },
    );
    const outcome = await verifyOidcJwt(token, {
      jwksResolver,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.claims.sub).toBe("auth0|organizer-1");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
