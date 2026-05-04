import type { Context } from "hono";

/**
 * API Gateway HTTP API + Cognito JWT authorizer 経由の payload v2 形式から
 * `custom:tenantId` claim を取り出す。
 *
 * Function URL (AWS_IAM) 直叩き経路 (ops / 開発時) では JWT claim が無いので
 * `DEFAULT_TENANT_ID` env にフォールバックする。本番運用では UI 経由 = HTTP API
 * 経由のみが想定されるので JWT claim 経路が常用。
 */
const FALLBACK_TENANT_ID = "unknown-tenant";

export interface JwtAuthorizerContext {
  readonly jwt?: {
    readonly claims?: Record<string, string | number | boolean | undefined>;
  };
}

export interface AuthorizerEvent {
  readonly requestContext?: {
    readonly authorizer?: JwtAuthorizerContext;
  };
}

export function extractTenantIdFromClaims(
  claims: Record<string, string | number | boolean | undefined> | undefined,
): string | undefined {
  if (!claims) return undefined;
  const raw = claims["custom:tenantId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveTenantId(c: Context): string {
  const event = c.env?.event as AuthorizerEvent | undefined;
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const fromJwt = extractTenantIdFromClaims(claims);
  if (fromJwt) return fromJwt;
  return process.env.DEFAULT_TENANT_ID ?? FALLBACK_TENANT_ID;
}
