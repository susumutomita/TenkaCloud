import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { Context } from "hono";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };

const SYSTEM_ADMIN_ROLE = "SystemAdmin";

/**
 * Cognito `sub` claim を取り出す (= operator の安定識別子)。
 * structured audit log (`admin.insight.read`) に `admin` フィールドとして埋める。
 * JWT 認可が無い経路 (= tests / local fallback) は `"unknown"` を返す。
 */
export function resolveCognitoSub(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const sub = claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : "unknown";
}

/**
 * Cognito `custom:userRole` claim が `SystemAdmin` か判定する。
 * SBT 標準の SystemAdmin identity を必須化する。
 *
 * SBT v0.3.9 の `auth-custom-resource/index.py` は admin user を `admin_create_user` で
 * 作成するとき、`custom:userRole = "SystemAdmin"` を user attribute として埋める。
 * Cognito Group ではなく custom attribute 経路を使うのが SBT の慣習なので、 group claim
 * (`cognito:groups`) は空のまま id_token に乗らない。 admin-insight handler は SBT に
 * 揃えて custom attribute で判定する。
 *
 * Tenant Admin 経路は `custom:userRole = "TenantAdmin"` (= provision-tenant.sh / SBT
 * UserManagementService が埋める)。 不一致な値は SystemAdmin と見なさない。
 *
 * API GW HTTP API JWT Authorizer は token 検証のみで role 値を見ないため、 本関数が
 * handler 内の二重防御として機能する。
 */
export function isSystemAdmin(c: Context): boolean {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const role = claims?.["custom:userRole"];
  return typeof role === "string" && role.trim() === SYSTEM_ADMIN_ROLE;
}
