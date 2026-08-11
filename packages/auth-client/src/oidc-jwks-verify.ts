/**
 * Issue #2292: generic, config-injected OIDC/JWKS JWT verifier.
 *
 * Always-On mode authenticates organizers with Auth0 (RS256 / JWKS),
 * NOT Cognito. The Workers control API is application-level (Cloudflare Workers, not
 * AWS API Gateway), so it cannot lean on the API Gateway JWT authorizer and needs an
 * in-process JWKS verifier that runs in BOTH Node 20+ and Cloudflare Workers.
 *
 * Design constraints honored here:
 *   - WebCrypto only (`crypto.subtle`) — runs on Node 20+ and Workers, zero new deps
 *     (no `jose`, no `node:crypto`). RS256/RS384/RS512 via
 *     `importKey("jwk", ..., { name: "RSASSA-PKCS1-v1_5", hash }, ...)` + `verify`.
 *   - Tenant-agnostic: issuer, audience and JWKS resolution are INJECTED. This
 *     primitive knows nothing about Auth0-tenant-specific namespaced role claims —
 *     that gate is a later, unresolved Phase-3 concern. Claims are returned as an
 *     opaque `Record<string, unknown>` for the caller to interpret.
 *   - Fail closed: every failure path returns a typed reason. The signature is
 *     verified BEFORE any claim (iss / aud / exp / nbf) is trusted, so a forged
 *     token can never have its claims read as authoritative.
 *   - No silent fallbacks: an unverifiable token is never reported as valid.
 *
 * This is a sibling of `packages/trust-bridge/src/jws.ts` (HS256 compact JWS) but for
 * the asymmetric RS256/JWKS path the Auth0 control plane needs.
 */

/**
 * A JSON Web Key. The DOM `JsonWebKey` dictionary (WebCrypto) omits `kid`, but real
 * JWKS entries carry one for key selection, so we widen it. The verifier never reads
 * `kid` off the JWK itself — key selection is the injected resolver's job (it matches
 * the token header `kid` to a JWKS entry); `kid` is surfaced here only for callers /
 * resolvers that need it.
 */
export type Jwk = JsonWebKey & { readonly kid?: string };

/**
 * Resolves a JWK for a token's `kid`. Async because a Workers resolver typically
 * fetches (and caches) the issuer's JWKS document over HTTP. Injecting it keeps the
 * network call out of this pure-ish verifier and makes the whole matrix testable
 * offline. Returns `undefined` when no key matches the `kid` (→ `key-not-found`).
 */
export type JwksResolver = (kid: string | undefined) => Promise<Jwk | undefined>;

export interface OidcVerifyOptions {
  readonly jwksResolver: JwksResolver;
  /** Expected `iss`. Compared for exact string equality. */
  readonly issuer: string;
  /** Expected `aud` membership. Matches a string `aud` or an element of an array `aud`. */
  readonly audience: string;
  /** Clock source (injectable for deterministic tests). Defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Leeway applied to `exp` / `nbf`, in seconds. Defaults to {@link DEFAULT_CLOCK_TOLERANCE_SEC}. */
  readonly clockToleranceSec?: number;
}

/** Decoded JOSE header. `alg` / `kid` are the only fields the verifier acts on. */
export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
  readonly [key: string]: unknown;
}

export type OidcVerifyFailureReason =
  | "malformed-token"
  | "unsupported-algorithm"
  | "missing-kid"
  | "key-not-found"
  | "signature-invalid"
  | "claims-parse-failed"
  | "issuer-mismatch"
  | "audience-mismatch"
  | "token-expired"
  | "token-not-yet-valid";

export type OidcVerifyOutcome =
  | {
      readonly valid: true;
      readonly claims: Record<string, unknown>;
      readonly header: JwtHeader;
    }
  | { readonly valid: false; readonly reason: OidcVerifyFailureReason };

/** Default `exp` / `nbf` leeway (seconds). Absorbs modest clock skew between issuer and verifier. */
export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

const MILLIS_PER_SECOND = 1000;

/**
 * Allowed asymmetric algorithms. RSASSA-PKCS1-v1_5 with the mapped digest. Symmetric
 * (`HS*`) and `none` are intentionally absent — this verifier only trusts asymmetric
 * signatures it can check against a public JWK.
 */
const ALG_TO_HASH: Readonly<Record<string, string>> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};

const RSASSA = "RSASSA-PKCS1-v1_5";

function fail(reason: OidcVerifyFailureReason): OidcVerifyOutcome {
  return { valid: false, reason };
}

/** Split a compact JWS into exactly three segments, or `undefined` if malformed. */
function splitCompact(token: string): [string, string, string] | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  return parts as [string, string, string];
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** UTF-8 encode into a fresh `ArrayBuffer`-backed view (WebCrypto `BufferSource`). */
function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

/**
 * base64url → UTF-8 → JSON object. Returns `undefined` on bad base64, non-JSON, or a
 * JSON value that is not a plain object (array / null / scalar). Never throws.
 */
function decodeJsonObject(segment: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Import the JWK and verify the RSASSA-PKCS1-v1_5 signature over `header.payload`.
 * Returns `false` on a bad signature AND on any import/decode error (fail closed —
 * an unusable key or corrupt signature segment is never treated as a valid signature).
 */
async function verifyRsaSignature(
  jwk: Jwk,
  hash: string,
  signingInput: string,
  signatureSegment: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: RSASSA, hash }, false, [
      "verify",
    ]);
    const signature = base64UrlToBytes(signatureSegment);
    return await crypto.subtle.verify({ name: RSASSA }, key, signature, encodeUtf8(signingInput));
  } catch {
    return false;
  }
}

function audienceMatches(aud: unknown, audience: string): boolean {
  if (typeof aud === "string") {
    return aud === audience;
  }
  if (Array.isArray(aud)) {
    return aud.includes(audience);
  }
  return false;
}

function checkTemporal(
  claims: Record<string, unknown>,
  now: Date,
  toleranceSec: number,
): "token-expired" | "token-not-yet-valid" | undefined {
  const nowSec = Math.floor(now.getTime() / MILLIS_PER_SECOND);
  const { exp, nbf } = claims;
  if (typeof exp === "number" && nowSec > exp + toleranceSec) {
    return "token-expired";
  }
  if (typeof nbf === "number" && nowSec < nbf - toleranceSec) {
    return "token-not-yet-valid";
  }
  return undefined;
}

/**
 * Validate the standard claims. Only called AFTER the signature is verified, so every
 * value read here is authenticated.
 */
function validateClaims(
  claims: Record<string, unknown>,
  options: OidcVerifyOptions,
): OidcVerifyFailureReason | undefined {
  if (typeof claims.iss !== "string" || claims.iss !== options.issuer) {
    return "issuer-mismatch";
  }
  if (!audienceMatches(claims.aud, options.audience)) {
    return "audience-mismatch";
  }
  const now = options.now ? options.now() : new Date();
  const tolerance = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  return checkTemporal(claims, now, tolerance);
}

/**
 * Verify a compact JWT (RS256/RS384/RS512 over JWKS) against injected issuer / audience
 * / clock. Fail-closed order:
 *   1. structural: 3 segments and a decodable header (else `malformed-token`)
 *   2. `alg` is an allowed asymmetric algorithm (else `unsupported-algorithm`)
 *   3. header carries a `kid` (else `missing-kid`)
 *   4. resolver returns a JWK for that `kid` (else `key-not-found`)
 *   5. signature over `header.payload` verifies (else `signature-invalid`)
 *   6. ONLY NOW parse the payload (else `claims-parse-failed`) and check
 *      `iss` / `aud` / `exp` / `nbf`.
 */
export async function verifyOidcJwt(
  token: string,
  options: OidcVerifyOptions,
): Promise<OidcVerifyOutcome> {
  const parts = splitCompact(token);
  if (!parts) {
    return fail("malformed-token");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const decodedHeader = decodeJsonObject(headerSegment);
  if (!decodedHeader) {
    return fail("malformed-token");
  }
  const header = decodedHeader as JwtHeader;

  const alg = typeof header.alg === "string" ? header.alg : "";
  const hash = ALG_TO_HASH[alg];
  if (!hash) {
    return fail("unsupported-algorithm");
  }

  const { kid } = header;
  if (typeof kid !== "string" || kid.length === 0) {
    return fail("missing-kid");
  }

  const jwk = await options.jwksResolver(kid);
  if (!jwk) {
    return fail("key-not-found");
  }

  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signatureOk = await verifyRsaSignature(jwk, hash, signingInput, signatureSegment);
  if (!signatureOk) {
    return fail("signature-invalid");
  }

  // Signature is authentic — from here the payload may be trusted.
  const claims = decodeJsonObject(payloadSegment);
  if (!claims) {
    return fail("claims-parse-failed");
  }

  const claimError = validateClaims(claims, options);
  if (claimError) {
    return fail(claimError);
  }

  return { valid: true, claims, header };
}
