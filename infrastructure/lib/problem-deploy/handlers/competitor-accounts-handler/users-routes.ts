import type { Context } from "hono";
import { z } from "zod";
import { extractClaims } from "../deploy-handler/auth.js";
import { extractUserPoolIdFromIss } from "./cognito-saml.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import {
  assertUserBelongsToTenant,
  type CognitoUserClientDeps,
  type CognitoUserSummary,
  createUser,
  deleteUser,
  listUsersByTenant,
} from "./users-cognito.js";

/**
 * Issue #925 Phase 1: Tenant Admin が tenant 内 user を CRUD する route 群。 既存
 * \`competitor-accounts\` Lambda に同居 (= IAM / auth 共通、 Phase 2 で別 Lambda 化を再評価)。
 *
 *   GET    /admin/users                    — tenant 内 user list (custom:tenantId filter)
 *   POST   /admin/users                    — invite (= AdminCreateUser、 email 招待 + 属性 set)
 *   DELETE /admin/users/:username          — 削除 (= AdminGetUser で tenantId 検証 → AdminDeleteUser)
 *
 * 設計判断:
 *   - **UserPool ID は JWT iss から runtime 抽出**: SAML routes と同パターン (= self-targeting)
 *   - **custom:tenantId は server が JWT から上書き**: caller が body に書いた tenantId は信頼しない
 *   - **role は当面 "TenantAdmin" のみ allow**: #926 で role enum 拡張するまで lock
 *   - **自分自身の削除を許さない**: lock-out 回避 (= Cognito sub と削除対象 username の比較)
 */

export interface UsersRouteResult {
  readonly status: number;
  readonly body: unknown;
}

const ALLOWED_ROLES = ["TenantAdmin"] as const;
export const InviteUserRequestSchema = z.object({
  email: z.string().email(),
  userRole: z.enum(ALLOWED_ROLES).default("TenantAdmin"),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

function extractSelfPoolFromContext(
  c: Context,
  shared: CompetitorAccountsSharedResources,
): CognitoUserClientDeps | undefined {
  const claims = extractClaims(c);
  const userPoolId = extractUserPoolIdFromIss(claims?.iss as string | undefined);
  if (!userPoolId) return undefined;
  return { client: shared.cognito, userPoolId };
}

function extractTenantMetadata(c: Context): {
  tenantName: string | undefined;
  tenantTier: string | undefined;
} {
  const claims = extractClaims(c);
  const tenantName = claims?.["custom:tenantName"];
  const tenantTier = claims?.["custom:tenantTier"];
  return {
    tenantName: typeof tenantName === "string" ? tenantName : undefined,
    tenantTier: typeof tenantTier === "string" ? tenantTier : undefined,
  };
}

export interface UsersRouteDeps {
  readonly shared: CompetitorAccountsSharedResources;
}

export async function routeListUsers(
  deps: UsersRouteDeps,
  c: Context,
  tenantId: string,
): Promise<UsersRouteResult> {
  const pool = extractSelfPoolFromContext(c, deps.shared);
  if (!pool) {
    return {
      status: 401,
      body: { error: "user_pool_unresolved", message: "JWT iss から UserPool を抽出できません" },
    };
  }
  const users = await listUsersByTenant(pool, tenantId);
  return { status: 200, body: { items: users } };
}

export async function routeCreateUser(
  deps: UsersRouteDeps,
  c: Context,
  tenantId: string,
  request: InviteUserRequest,
): Promise<UsersRouteResult> {
  const pool = extractSelfPoolFromContext(c, deps.shared);
  if (!pool) {
    return {
      status: 401,
      body: { error: "user_pool_unresolved", message: "JWT iss から UserPool を抽出できません" },
    };
  }
  const { tenantName, tenantTier } = extractTenantMetadata(c);
  const summary: CognitoUserSummary = await createUser(pool, {
    email: request.email,
    tenantId,
    userRole: request.userRole,
    tenantName,
    tenantTier,
  });
  return { status: 201, body: summary };
}

export async function routeDeleteUser(
  deps: UsersRouteDeps,
  c: Context,
  tenantId: string,
  username: string,
): Promise<UsersRouteResult> {
  const pool = extractSelfPoolFromContext(c, deps.shared);
  if (!pool) {
    return {
      status: 401,
      body: { error: "user_pool_unresolved", message: "JWT iss から UserPool を抽出できません" },
    };
  }
  // lock-out 防止: caller 自身の username (= Cognito `cognito:username` claim) と削除対象が一致する
  // request は拒否する。 sub での比較ではなく username で比較するのは、 AdminDelete の引数が
  // username (= email alias 含む) で sub は受け付けないため。
  const claims = extractClaims(c);
  const callerUsername = claims?.["cognito:username"];
  if (typeof callerUsername === "string" && callerUsername === username) {
    return {
      status: 409,
      body: { error: "cannot_delete_self", message: "lock-out 防止のため自分自身は削除できません" },
    };
  }
  await assertUserBelongsToTenant(pool, username, tenantId);
  await deleteUser(pool, username);
  return { status: 200, body: { deleted: true, username } };
}
