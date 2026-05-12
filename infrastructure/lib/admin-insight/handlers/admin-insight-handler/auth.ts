import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { Context } from "hono";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };

/**
 * Cognito `sub` claim を取り出す (= operator の安定識別子)。
 * ADR-011 D5 の structured audit log (`admin.insight.read`) に `admin` フィールドとして埋める。
 * JWT 認可が無い経路 (= tests / local fallback) は `"unknown"` を返す。
 */
export function resolveCognitoSub(c: Context): string {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const sub = claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : "unknown";
}

/**
 * Cognito `cognito:groups` claim に `SystemAdmin` が含まれているか判定する。
 * ADR-011 D2 採用案 = SBT 標準 SystemAdmin group の Cognito claim を必須化。
 *
 * API GW の JWT Authorizer (= group check 機能なし) で認可は通っても、claim 検査は
 * 二重防御として handler 側でもう一度行う。`SystemAdmin` group に属さない token を
 * 持つ Tenant Admin が誤って本 API を叩いても 403 で弾く。
 *
 * `cognito:groups` claim は spec 上 `string[]` だが、API Gateway v2 JWT Authorizer は
 * 単一要素を string に潰すことがあるため、両形式を受け付ける。
 */
export function isSystemAdmin(c: Context): boolean {
  const event = (c.env as { event?: APIGatewayProxyEventV2WithJWTAuthorizer } | undefined)?.event;
  const claims = event?.requestContext?.authorizer?.jwt?.claims as JwtClaims | undefined;
  const raw = claims?.["cognito:groups"];
  if (raw === undefined) return false;
  if (typeof raw === "string") {
    // API GW v2 が `"[SystemAdmin]"` / `"SystemAdmin"` / `"foo,SystemAdmin,bar"` 等いずれの
    // 表現で渡してきても拾えるように、bracket / comma で粗く split して trim する。
    return raw
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => s.trim())
      .includes("SystemAdmin");
  }
  if (Array.isArray(raw)) {
    return raw.includes("SystemAdmin");
  }
  return false;
}
