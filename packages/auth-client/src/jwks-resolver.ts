/**
 * Issue #2292: generic caching JWKS resolver.
 *
 * Pairs with the verifier in `oidc-jwks-verify.ts`. The Always-On Workers
 * control plane authenticates organizers against Auth0 (RS256 / JWKS). Fetching the
 * issuer's JWKS document on every request would add a network round-trip to each
 * verification, so this resolver fetches once, indexes the keys by `kid`, and serves
 * them from an in-closure cache with a TTL. It returns the {@link JwksResolver}
 * function shape that `verifyOidcJwt` consumes — so it drops straight into
 * `OidcVerifyOptions.jwksResolver`.
 *
 * Design constraints honored here:
 *   - Zero new deps: uses the global `fetch` (Node 20+ and Cloudflare Workers),
 *     injectable as `fetchImpl` so the whole matrix is testable offline.
 *   - Tenant-agnostic: the JWKS URI is a parameter — this construct knows nothing
 *     about which Auth0 tenant it points at.
 *   - Deterministic: the TTL clock is injected as `now()` (epoch ms) so tests drive
 *     cache expiry without real time. `Date.now` is never read at module top-level.
 *   - Fail closed: any fetch / parse error PROPAGATES (the returned promise rejects).
 *     We deliberately never swallow a failure into `undefined`, because `undefined`
 *     means "no key for this kid" to the verifier (→ `key-not-found`) — swallowing an
 *     outage as a benign key miss would mask the outage and could, over a rotation,
 *     let a valid token be rejected silently. A resolver throw is a hard failure the
 *     verifier surfaces, never a quiet stale/wrong key.
 */

import type { Jwk, JwksResolver } from "./oidc-jwks-verify";

export interface CachingJwksResolverOptions {
  /** Absolute URL of the issuer's JWKS document (e.g. `https://tenant.us.auth0.com/.well-known/jwks.json`). */
  readonly jwksUri: string;
  /** Fetch implementation. Injectable for tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Cache lifetime in seconds. Defaults to {@link DEFAULT_CACHE_TTL_SEC}. */
  readonly cacheTtlSec?: number;
  /** Clock source in epoch milliseconds. Injectable for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Default keyset cache lifetime (seconds). One hour balances rotation latency against fetch volume. */
export const DEFAULT_CACHE_TTL_SEC = 3600;

const MILLIS_PER_SECOND = 1000;

/** A cached keyset: the kid→JWK index plus the epoch-ms timestamp it was fetched at. */
interface CachedKeyset {
  readonly keysByKid: Map<string, Jwk>;
  readonly fetchedAtMs: number;
}

/**
 * Build a caching {@link JwksResolver} bound to a single JWKS URI.
 *
 * Lookup policy per call, given the header `kid`:
 *   - `kid === undefined` → resolve `undefined` WITHOUT fetching. A token with no kid
 *     can never match a JWKS entry (every entry is keyed by kid) and the verifier
 *     already maps this to `missing-kid`; skipping the call stops kid-less tokens from
 *     driving JWKS fetch traffic.
 *   - cache fresh (`now() - fetchedAtMs < ttlMs`) AND kid present → return it.
 *   - cache fresh but kid absent → refetch ONCE (the issuer may have rotated keys),
 *     update the cache, then return the kid's key or `undefined`.
 *   - cache stale or empty → fetch, update the cache, return the kid's key or `undefined`.
 *
 * Concurrency: N simultaneous cache misses share ONE in-flight fetch (deduped via a
 * shared promise that is cleared on settle), so a burst of verifies triggers a single
 * network request rather than N.
 */
export function createCachingJwksResolver(options: CachingJwksResolverOptions): JwksResolver {
  const { jwksUri } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const ttlMs = (options.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC) * MILLIS_PER_SECOND;

  let cache: CachedKeyset | undefined;
  // Shared in-flight fetch: concurrent misses collapse to a single request. Cleared on
  // settle so a later miss (stale cache / rotation) can fetch again.
  let inFlight: Promise<CachedKeyset> | undefined;

  async function fetchKeyset(): Promise<CachedKeyset> {
    const response = await fetchImpl(jwksUri);
    if (!response.ok) {
      // Fail loud: a non-2xx JWKS endpoint is an outage, not a key miss.
      throw new Error(
        `JWKS fetch failed: ${jwksUri} responded with HTTP status ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      throw new Error(`JWKS document is malformed: ${jwksUri} did not return a JSON object`);
    }
    const keys = (body as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) {
      throw new Error(`JWKS document is malformed: ${jwksUri} has no "keys" array`);
    }
    const keysByKid = new Map<string, Jwk>();
    for (const key of keys as readonly Jwk[]) {
      // Index by kid; entries without a string kid can never be selected, so skip them.
      if (typeof key.kid === "string") {
        keysByKid.set(key.kid, key);
      }
    }
    return { keysByKid, fetchedAtMs: now() };
  }

  function refresh(): Promise<CachedKeyset> {
    if (!inFlight) {
      inFlight = fetchKeyset()
        .then((keyset) => {
          cache = keyset;
          return keyset;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  }

  return async (kid) => {
    if (kid === undefined) {
      return undefined;
    }

    if (cache !== undefined && now() - cache.fetchedAtMs < ttlMs) {
      const cached = cache.keysByKid.get(kid);
      if (cached !== undefined) {
        return cached;
      }
      // Fresh cache but no entry for this kid → keys may have rotated since the last
      // fetch. Fall through to refetch ONCE and re-check before returning undefined.
    }

    const keyset = await refresh();
    return keyset.keysByKid.get(kid);
  };
}
