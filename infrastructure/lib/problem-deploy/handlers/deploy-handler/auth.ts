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
 * Issue #843: JWT に `custom:tenantId` が無く `DEFAULT_TENANT_ID` env も無い request は
 * 401 で **fail-closed**。 旧 silent fallback (`"unknown-tenant"` 文字列) は SSM /
 * DDB / EventBridge に bogus 行を量産する原因だったため削除した。
 *
 * 旧 fail-closed を一旦 rollback した理由 (Cognito UserPoolClient `readAttributes` に
 * `custom:tenantId` が無く id_token に claim が載らなかった既存 tenant の regression、
 * PR-697 rollback) は Issue #686 で解消済み:
 *  - `tenant-template/identity-provider.ts` の `readAttributes` が `custom:tenantId`
 *    `userRole` / `apiKey` / `tenantTier` / `tenantName` を明示 (= JWT に確実に乗る)
 *  - `provision-tenant.sh` が `admin-create-user` 時に `custom:tenantId` を必ず set
 *  - 3 handler (deploy / event / competitor-accounts) の `onError` で
 *    `MissingTenantClaimError` → 401 `missing_tenant_claim` を返す配線が完備
 *
 * `DEFAULT_TENANT_ID` env は test 環境 (= `app.request()` で JWT を bypass する unit
 * test) と TenkaCloud Lite の dev override 用にのみ残す。 prod では env を渡さない
 * ので、 JWT claim 欠落は **必ず** 401 になる。
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
  if (fromEnv) return fromEnv;
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
