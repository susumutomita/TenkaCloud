import type { Context } from "hono";
import { extractClaims, type JwtClaims } from "../shared/jwt-claims.js";
import { getMachinePrincipal } from "../shared/machine-principal.js";

export type { JwtClaims };
/**
 * claim 抽出の実装は `shared/jwt-claims.ts` に移した (#2948: machine guard との import cycle を
 * 避けるため)。既存 caller のために同じ名前で re-export する。
 */
export { extractClaims };

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

/**
 * #2948: tenant の解決順は **JWT claim → machine principal → env fallback** で固定する。
 *
 * machine 分岐は terminal である。machine principal が解決できた request は
 * `DEFAULT_TENANT_ID` env に落ちない (= 誤って env を設定した環境で machine token が別 tenant を
 * 名乗るのを防ぐ)。principal は guard middleware が publish した値だけを読み、claims を
 * ここで再 parse しない (= 検証済みの経路を 1 本に保つ)。
 */
export function resolveTenantId(c: Context): string {
  const fromJwt = extractTenantIdFromClaims(extractClaims(c));
  if (fromJwt) return fromJwt;
  const machine = getMachinePrincipal(c);
  if (machine) return machine.tenantId;
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

/**
 * #2948 / ADR-0005: machine (M2M) principal の role。
 *
 * **`TenantOperator` を投影しない** ことが本設計の中核である。`requireRole` は
 * `allowedRoles.includes(role)` の strict 判定なので、既存のどの allowlist にも含まれない
 * `TenantMachine` は destructive route 全部で無条件に落ちる — guard middleware を丸ごと削除
 * しても、である。
 *
 * `TENANT_ROLES` / `TenantRole` 型は **human 3 値のまま広げない**。SPA の
 * `resolveTenantConsoleAccess` など human 前提の consumer に machine 値を流し込まないため。
 * blanket middleware だけが `TENANT_BLANKET_ROLES` を使う。
 */
export const TENANT_MACHINE_ROLE = "TenantMachine";

/**
 * blanket (= 「認証済みの誰か」) 判定専用の role 集合。per-route の `requireRole` には
 * 使わない。`TENANT_MACHINE_ROLE` を per-route allowlist に足してよいのは、machine から
 * 到達させると決めた route だけである (Phase 1 では `POST /problems/:problemId/deploy` の 1 本)。
 */
export const TENANT_BLANKET_ROLES = [...TENANT_ROLES, TENANT_MACHINE_ROLE] as const;

export function extractUserRoleFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  const raw = claims["custom:userRole"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractTenantSuspendedFromClaims(claims: JwtClaims | undefined): boolean {
  if (!claims) return false;
  const raw = claims["custom:isSuspended"];
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/**
 * `custom:userRole` claim を取り出す。 JWT 不在経路 (= test) では env fallback。
 *
 * #2948: 解決順は `resolveTenantId` と同じく **JWT claim → machine principal → env fallback**
 * で、machine 分岐は terminal。machine principal が解決できた request は必ず
 * `TenantMachine` になり、`DEFAULT_USER_ROLE` env には落ちない。
 */
export function resolveUserRole(c: Context): string | undefined {
  const fromJwt = extractUserRoleFromClaims(extractClaims(c));
  if (fromJwt) return fromJwt;
  if (getMachinePrincipal(c)) return TENANT_MACHINE_ROLE;
  const fromEnv = process.env.DEFAULT_USER_ROLE;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export class TenantSuspendedError extends Error {
  constructor() {
    super("この tenant は一時停止中のため、新規イベント作成・問題デプロイは実行できません");
    this.name = "TenantSuspendedError";
  }
}

function hasTenantSuspensionClaim(claims: JwtClaims | undefined): boolean {
  return claims ? Object.hasOwn(claims, "custom:isSuspended") : false;
}

/**
 * Issue #1768: control-plane が tenant suspension を Cognito claim に投影した後に
 * App Plane mutating routes が参照する guard。DEFAULT_TENANT_SUSPENDED は unit test /
 * local fallback 用で、JWT claim がある場合は claim を優先する。
 */
export function isTenantSuspended(c: Context): boolean {
  const claims = extractClaims(c);
  if (hasTenantSuspensionClaim(claims)) return extractTenantSuspendedFromClaims(claims);
  return (process.env.DEFAULT_TENANT_SUSPENDED ?? "").trim().toLowerCase() === "true";
}

export function requireTenantNotSuspended(c: Context): void {
  if (isTenantSuspended(c)) throw new TenantSuspendedError();
}

/**
 * ADR-020 / Issue #926 Phase B: 任意の \`allowedRoles\` array で role gate する helper。
 * 一致なら return、 不一致 / 不在 / allowedRoles 空配列なら \`ForbiddenRoleError\` を throw。
 * caller (handler) は route の middleware で \`requireRole(c, [TENANT_ADMIN_ROLE])\` のように呼ぶ。
 */
export function requireRole(c: Context, allowedRoles: readonly string[]): void {
  const role = resolveUserRole(c);
  if (allowedRoles.length === 0 || role === undefined || !allowedRoles.includes(role)) {
    throw new ForbiddenRoleError(role, allowedRoles);
  }
}
