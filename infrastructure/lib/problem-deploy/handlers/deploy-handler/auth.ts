import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { Context } from "hono";

const FALLBACK_TENANT_ID = "unknown-tenant";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };

export function extractTenantIdFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  const raw = claims["custom:tenantId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveTenantId(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const fromJwt = extractTenantIdFromClaims(claims);
  if (fromJwt) return fromJwt;
  return process.env.DEFAULT_TENANT_ID ?? FALLBACK_TENANT_ID;
}
