import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyWithCognitoAuthorizerEvent,
} from "aws-lambda";
import type { Context } from "hono";

/**
 * JWT claim の読み出しだけを持つ最小 module。
 *
 * `deploy-handler/auth.ts` から切り出した理由は循環 import の回避である。#2948 の
 * machine guard (`shared/machine-principal.ts`) は claims を読む必要があり、逆に
 * `auth.ts` は guard が context へ publish した principal を読む。両者が同じ module に
 * 同居していると import cycle になるため、claim 抽出だけを下位 layer に置く。
 *
 * `auth.ts` は後方互換のため本 module の `extractClaims` / `JwtClaims` を re-export する。
 */

export type JwtClaimValue = string | number | boolean | string[];
export type JwtClaims = { readonly [name: string]: JwtClaimValue };

/**
 * tenant API は REST API + `CognitoUserPoolsAuthorizer`、 admin-insight などは HTTP API +
 * JWT Authorizer。 claims が出る位置が違うので両方を見る。
 *  - REST API + Cognito: `event.requestContext.authorizer.claims`
 *  - HTTP API V2 + JWT:  `event.requestContext.authorizer.jwt.claims`
 *
 * Hono が乗っているのは aws-lambda adapter (= raw event は `c.env.event` で参照可)。 どちらの
 * authorizer 形式でも handler が同じ claim を引けるようにする。
 */
type AuthorizerEvent =
  | APIGatewayProxyEventV2WithJWTAuthorizer
  | APIGatewayProxyWithCognitoAuthorizerEvent;

export function extractClaims(c: Context): JwtClaims | undefined {
  const event = (c.env as { event?: AuthorizerEvent } | undefined)?.event;
  const authorizer = event?.requestContext?.authorizer;
  if (!authorizer) return undefined;
  const v2 = (authorizer as { jwt?: { claims?: unknown } }).jwt?.claims;
  if (v2 && typeof v2 === "object") return v2 as JwtClaims;
  const v1 = (authorizer as { claims?: unknown }).claims;
  if (v1 && typeof v1 === "object") return v1 as JwtClaims;
  return undefined;
}
