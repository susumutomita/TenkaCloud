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
 * Issue #686 (revisit): 旧 fail-closed (= JWT claim 欠落で `MissingTenantClaimError` throw)
 * は Cognito UserPoolClient の readAttributes 設定漏れで `custom:tenantId` が id_token に
 * 載らない既存 tenant に対し GET /events が全部 500 になる regression を引き起こした
 * (PR-697 deploy 後の事故報告)。
 *
 * 暫定 rollback: silent fallback `"unknown-tenant"` に戻す。 別途、
 *  (a) tenant-template/identity-provider.ts の UserPoolClient `readAttributes` に
 *      `custom:tenantId` を明示追加 (= JWT に確実に乗せる)
 *  (b) frontend が `tenantId === "unknown-tenant"` を 「(自動検出中)」 で表示する band-aid
 * の 2 経路で正解に近づける (= 別 PR)。
 *
 * `MissingTenantClaimError` class は handler 側 onError 配線が既に残っているため、
 * type 互換のために残置 (= 将来 fail-closed 復帰時に再利用可能)。
 */
export class MissingTenantClaimError extends Error {
  constructor() {
    super(
      "JWT に custom:tenantId claim がありません (tenant 招待メール経由で再ログインしてください)",
    );
    this.name = "MissingTenantClaimError";
  }
}

const FALLBACK_TENANT_ID = "unknown-tenant";

export function resolveTenantId(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const fromJwt = extractTenantIdFromClaims(claims);
  if (fromJwt) return fromJwt;
  return process.env.DEFAULT_TENANT_ID ?? FALLBACK_TENANT_ID;
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
