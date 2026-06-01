/**
 * JWT claim helpers for the IdP CRUD handler.
 *
 * The Control Plane uses `custom:userRole == SystemAdmin`; the Application
 * Plane uses `custom:userRole == TenantAdmin` and binds to the caller's
 * `custom:tenantId` claim. Both planes share the same shape — only the role
 * string and the tenant-scope binding differ.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyWithCognitoAuthorizerEvent,
} from "aws-lambda";
import type { Context } from "hono";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };
type AuthorizerEvent =
  | APIGatewayProxyEventV2WithJWTAuthorizer
  | APIGatewayProxyWithCognitoAuthorizerEvent;

const SYSTEM_ADMIN_ROLE = "SystemAdmin";
const TENANT_ADMIN_ROLE = "TenantAdmin";

function readClaim(c: Context, name: string): string | undefined {
  const event = (c.env as { event?: AuthorizerEvent } | undefined)?.event;
  const authorizer = event?.requestContext?.authorizer;
  if (!authorizer) return undefined;
  const v2 = (authorizer as { jwt?: { claims?: unknown } }).jwt?.claims;
  const v1 = (authorizer as { claims?: unknown }).claims;
  const claims = (v2 && typeof v2 === "object" ? v2 : v1) as JwtClaims | undefined;
  const raw = claims?.[name];
  return typeof raw === "string" ? raw : undefined;
}

export function resolveCognitoSub(c: Context): string {
  return readClaim(c, "sub") ?? "unknown";
}

export function isSystemAdmin(c: Context): boolean {
  return readClaim(c, "custom:userRole")?.trim() === SYSTEM_ADMIN_ROLE;
}

export function isTenantAdmin(c: Context): boolean {
  return readClaim(c, "custom:userRole")?.trim() === TENANT_ADMIN_ROLE;
}

/**
 * Pull `custom:tenantId` from the JWT. Required for any Application Plane
 * route. Returns `undefined` if absent (= handler returns 403).
 */
export function resolveTenantId(c: Context): string | undefined {
  const claim = readClaim(c, "custom:tenantId");
  return claim && claim.length > 0 ? claim : undefined;
}
