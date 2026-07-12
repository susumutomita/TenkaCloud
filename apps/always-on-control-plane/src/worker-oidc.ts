import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";
import type { AppEnvironment } from "./types.js";

const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";
const JWKS_PATH = "/.well-known/jwks.json";

interface PublicEs256Jwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly use: "sig";
  readonly alg: "ES256";
}

function issuerFromUrl(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HTTPException(StatusCodes.INTERNAL_SERVER_ERROR, {
      message: `${name} is required for the Worker OIDC JWKS`,
    });
  }
  return value;
}

export function workerOidcDiscovery(requestUrl: string): Record<string, unknown> {
  const issuer = issuerFromUrl(requestUrl);
  return {
    issuer,
    jwks_uri: `${issuer}${JWKS_PATH}`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    claims_supported: ["aud", "exp", "iat", "iss", "sub"],
  };
}

export function publicJwksFromEnvironment(environment: AppEnvironment["Bindings"]): {
  readonly keys: readonly PublicEs256Jwk[];
} {
  const rawPrivateJwk = requireString(
    environment.INTENT_SIGNING_PRIVATE_JWK,
    "INTENT_SIGNING_PRIVATE_JWK",
  );
  const parsed = JSON.parse(rawPrivateJwk) as JsonWebKey & { readonly kid?: string };
  const publicJwk: PublicEs256Jwk = {
    kty: "EC",
    crv: "P-256",
    x: requireString(parsed.x, "INTENT_SIGNING_PRIVATE_JWK.x"),
    y: requireString(parsed.y, "INTENT_SIGNING_PRIVATE_JWK.y"),
    kid: requireString(parsed.kid, "INTENT_SIGNING_PRIVATE_JWK.kid"),
    use: "sig",
    alg: "ES256",
  };
  return { keys: [publicJwk] };
}

export { JWKS_PATH, OIDC_DISCOVERY_PATH };
