import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyWithCognitoAuthorizerEvent,
} from "aws-lambda";
import type { Context } from "hono";

type JwtClaimValue = string | number | boolean | string[];
type JwtClaims = { readonly [name: string]: JwtClaimValue };

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
  const fromJwt = extractTenantIdFromClaims(extractClaims(c));
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
  const sub = extractClaims(c)?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : "unknown";
}

/**
 * Issue #854: TenantAdmin / SystemAdmin の role enforcement。
 *
 * 旧コードは Cognito JWT authorizer (= 署名 + expiry 検証) を通った request を 「TenantAdmin
 * 認可済」 と comment で書いていたが、 実態は **誰でも (= tenant 内の一般 user / monitor bot 等)
 * destructive 操作ができる** 状態だった。 \`custom:userRole\` claim を見て role check しないと
 * \`/admin/*\` route + destructive event route が tenant 内の誰でも実行できてしまう。
 *
 * `provision-tenant.sh` は admin-create-user で **TenantAdmin** を set する (= line 99)。
 * 将来別 role (= 例 TenantViewer / Auditor) を増やすなら、 allowedRoles を caller で渡す形に
 * 拡張する想定。
 *
 * `DEFAULT_USER_ROLE` env (= test / local override 用) を持ち、 unit test (= app.request で
 * JWT bypass) が role check を pass できるようにする。 prod では env を渡さない。
 */
export class ForbiddenRoleError extends Error {
  constructor(
    public readonly actualRole: string | undefined,
    public readonly requiredRoles: readonly string[],
  ) {
    super(
      `role "${actualRole ?? "(none)"}" is not authorized to perform this action (required: ${requiredRoles.join(", ")})`,
    );
    this.name = "ForbiddenRoleError";
  }
}

/**
 * ADR-020 / Issue #926 Phase B: tenant 内 role enum。 \`custom:userRole\` claim に入る値の正本。
 *
 *   TenantAdmin    — destructive 全部 (user 管理 / SAML / 削除 / IAM mutate)
 *   TenantOperator — mutate 可 (deploy / event 進行 / disruption fire) だが user 管理は不可
 *   TenantViewer   — read-only (= 監査担当 / dashboard 観覧)
 *
 * SystemAdmin は SBT ControlPlane が \`cognito:groups\` で払い出す別軸 (= admin-insight 専用、
 * ADR-011 D2)。 tenant 側 helper では扱わない。
 */
export const TENANT_ADMIN_ROLE = "TenantAdmin";
export const TENANT_OPERATOR_ROLE = "TenantOperator";
export const TENANT_VIEWER_ROLE = "TenantViewer";
export const TENANT_ROLES = [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE, TENANT_VIEWER_ROLE] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export function extractUserRoleFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  const raw = claims["custom:userRole"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `custom:userRole` claim を取り出す。 JWT 不在経路 (= test) では env fallback。
 */
export function resolveUserRole(c: Context): string | undefined {
  const fromJwt = extractUserRoleFromClaims(extractClaims(c));
  if (fromJwt) return fromJwt;
  const fromEnv = process.env.DEFAULT_USER_ROLE;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * ADR-020 / Issue #926 Phase B: 任意の \`allowedRoles\` array で role gate する helper。
 * 一致なら return、 不一致 / 不在 / allowedRoles 空配列なら \`ForbiddenRoleError\` を throw。
 *
 * 既存 \`requireTenantAdmin(c)\` は \`requireRole(c, [TENANT_ADMIN_ROLE])\` の alias として
 * 残し、 caller 互換を保つ。 Phase B.1 で各 handler の middleware を granular に置換する。
 */
export function requireRole(c: Context, allowedRoles: readonly string[]): void {
  const role = resolveUserRole(c);
  if (allowedRoles.length === 0 || role === undefined || !allowedRoles.includes(role)) {
    throw new ForbiddenRoleError(role, allowedRoles);
  }
}

/**
 * \`custom:userRole === "TenantAdmin"\` を要求する。 不一致 / 不在なら \`ForbiddenRoleError\`
 * を throw。 handler 側 onError で 403 にマップする。
 *
 * caller (handler) は \`/admin/*\` route と destructive event route の 1 行目で呼ぶ。
 * ADR-020 Phase B: \`requireRole(c, [TENANT_ADMIN_ROLE])\` の alias。 既存 caller 互換のため残す。
 */
export function requireTenantAdmin(c: Context): void {
  requireRole(c, [TENANT_ADMIN_ROLE]);
}
