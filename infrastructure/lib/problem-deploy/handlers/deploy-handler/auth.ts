import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { Context } from "hono";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };

export function extractTenantIdFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  const raw = claims["custom:tenantId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Issue #686: JWT に `custom:tenantId` が無い + `DEFAULT_TENANT_ID` env も unset の場合に
 * silent fallback `"unknown-tenant"` を返していたため、 全 row が同 partition に書かれ
 * UI に `Tenant: unknown-tenant` が出ていた。 fail-closed に変更し、 caller (handler) が
 * 401 Unauthorized で弾けるよう Error を throw する。
 *
 * `DEFAULT_TENANT_ID` env は dev / local 経路向けの explicit override として残す。
 */
export class MissingTenantClaimError extends Error {
  constructor() {
    super(
      "JWT に custom:tenantId claim がありません (tenant 招待メール経由で再ログインしてください)",
    );
    this.name = "MissingTenantClaimError";
  }
}

export function resolveTenantId(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const fromJwt = extractTenantIdFromClaims(claims);
  if (fromJwt) return fromJwt;
  const fromEnv = process.env.DEFAULT_TENANT_ID;
  if (fromEnv && fromEnv.length > 0 && fromEnv !== "unknown-tenant") return fromEnv;
  throw new MissingTenantClaimError();
}

/**
 * Cognito `sub` claim を取り出す (= operator の安定識別子)。Notifications の
 * `createdBy` 監査用などで使う。JWT 認可が無い経路 (= tests / local fallback) は
 * `"unknown"` を返す。
 */
export function resolveCognitoSub(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const sub = claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : "unknown";
}
