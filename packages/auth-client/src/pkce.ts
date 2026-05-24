/**
 * PKCE (RFC 7636) helpers for OAuth 2.0 Code Flow with public clients.
 * Verifier is 43-128 chars of [A-Z,a-z,0-9,-._~]. Challenge is base64url(SHA-256(verifier)).
 *
 * Browser-only: relies on `crypto.getRandomValues` and `crypto.subtle.digest`.
 * Issue #1246: extracted from per-app duplicates (admin-console / application-admin-console)
 * into the shared `@tenkacloud/auth-client` package.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateVerifier(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, length);
}

export async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
