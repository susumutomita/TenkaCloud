import { base64UrlEncode } from "./crypto.js";

/**
 * Issue #2555: the Worker acts as an OIDC identity provider for AWS commands.
 *
 * AWS IAM registers this Worker's origin as an OIDC identity provider and
 * fetches these two public documents to validate the short-lived ES256 JWTs
 * the command path exchanges via `sts:AssumeRoleWithWebIdentity`. The signing
 * key pair lives in the Workers secret `OIDC_SIGNING_PRIVATE_JWK`; only its
 * public half is ever served. Rotation is a redeploy of that secret — AWS
 * re-reads the JWKS automatically.
 */

/** The one token-signing algorithm this issuer supports (asymmetric only). */
export const OIDC_SIGNING_ALGORITHM = "ES256";

export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";
export const JWKS_PATH = "/.well-known/jwks.json";

/** Bindings consumed here; `OIDC_SIGNING_PRIVATE_JWK` is a Workers secret, not a var. */
export interface OidcEnvironment {
  readonly OIDC_SIGNING_PRIVATE_JWK?: string;
}

/**
 * Discovery document limited to the fields IAM requires of an OIDC identity
 * provider (issuer, jwks_uri, claims_supported, response_types_supported,
 * subject_types_supported, id_token_signing_alg_values_supported). The issuer
 * is the serving origin, so the document is self-consistent on whichever
 * hostname IAM registered.
 */
export function buildOpenIdConfiguration(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}${JWKS_PATH}`,
    claims_supported: ["aud", "exp", "iat", "iss", "sub"],
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [OIDC_SIGNING_ALGORITHM],
  };
}

export interface EcPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly use: "sig";
  readonly alg: typeof OIDC_SIGNING_ALGORITHM;
}

function requiredJwkMember(jwk: Record<string, unknown>, key: string): string {
  const value = jwk[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OIDC_SIGNING_PRIVATE_JWK is missing the "${key}" member`);
  }
  return value;
}

/** RFC 7638 JWK thumbprint of an EC public key (its canonical required members). */
async function jwkThumbprint(x: string, y: string): Promise<string> {
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x, y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface OidcSigningKey {
  /** Validated private JWK, importable for ES256 signing (the command path). */
  readonly privateJwk: Record<string, unknown>;
  /** The served public half; its `kid` is what minted tokens must carry. */
  readonly publicJwk: EcPublicJwk;
}

/**
 * Parse + validate the Workers secret into the signing key pair view. The
 * public half is built member-by-member so private material (`d`, `key_ops`,
 * …) can never leak into the JWKS; a misconfigured deployment fails loudly at
 * use. `d` is required — a public-only JWK cannot back the command path.
 */
export async function signingKeyFromEnvironment(
  environment: OidcEnvironment,
): Promise<OidcSigningKey> {
  const raw = environment.OIDC_SIGNING_PRIVATE_JWK;
  if (raw === undefined || raw === "") {
    throw new Error("OIDC_SIGNING_PRIVATE_JWK is not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OIDC_SIGNING_PRIVATE_JWK must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OIDC_SIGNING_PRIVATE_JWK must be a JWK object");
  }
  const jwk = parsed as Record<string, unknown>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error("OIDC_SIGNING_PRIVATE_JWK must be an EC P-256 JWK");
  }
  const x = requiredJwkMember(jwk, "x");
  const y = requiredJwkMember(jwk, "y");
  const d = requiredJwkMember(jwk, "d");
  const kid =
    typeof jwk.kid === "string" && jwk.kid.length > 0 ? jwk.kid : await jwkThumbprint(x, y);
  return {
    privateJwk: { kty: "EC", crv: "P-256", x, y, d },
    publicJwk: { kty: "EC", crv: "P-256", x, y, kid, use: "sig", alg: OIDC_SIGNING_ALGORITHM },
  };
}

/** Derive only the served public JWK from the private signing secret. */
export async function publicJwkFromEnvironment(environment: OidcEnvironment): Promise<EcPublicJwk> {
  return (await signingKeyFromEnvironment(environment)).publicJwk;
}
