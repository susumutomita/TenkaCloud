import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { Context } from "hono";
import { z } from "zod";
import { resolveCognitoSub } from "./auth.js";
import {
  createSystemUser,
  DuplicateSystemUserError,
  deleteSystemUser,
  getSystemUser,
  listSystemUsers,
  SYSTEM_ADMIN_GROUP,
  SYSTEM_AUDITOR_GROUP,
  SYSTEM_GROUPS,
  type SystemUserClientDeps,
  SystemUserNotFoundError,
  updateSystemUserRole,
} from "./system-users-cognito.js";

/**
 * Issue #949 (ADR-020 Phase C): SystemAdmin Console 側の system user 管理 route 群。
 *
 *   GET    /admin/insight/system-users               — 一覧 (SystemAdmin + SystemAuditor 合算)
 *   POST   /admin/insight/system-users               — invite (email + role)
 *   GET    /admin/insight/system-users/:username     — detail
 *   PATCH  /admin/insight/system-users/:username     — role 変更 (group remove + add)
 *   DELETE /admin/insight/system-users/:username     — 削除 (self-delete 防止)
 *
 * Auth:
 *   - 1 段目: API Gateway HTTP API JWT Authorizer (ControlPlane UserPool)
 *   - 2 段目: handler 内で `cognito:groups ⊇ {SystemAdmin}` を検査 (= `isSystemAdmin` 既存 helper)
 *
 * Lock-out 防止:
 *   - 自分自身の削除 / role downgrade を 409 で拒否 (= sub / username 比較)
 *   - SystemAdmin が 0 人になる shutdown は本 Phase では検査しない (= 後続 Phase で 「最低 1 人残す」
 *     ルールを追加する余地。 まずは self-action のみ防御)
 */

export interface SystemUsersRouteResult {
  readonly status: number;
  readonly body: unknown;
}

export const InviteSystemUserRequestSchema = z.object({
  email: z.string().email(),
  role: z.enum(SYSTEM_GROUPS),
});

export const ChangeSystemUserRoleRequestSchema = z.object({
  role: z.enum(SYSTEM_GROUPS),
});

export type InviteSystemUserRequest = z.infer<typeof InviteSystemUserRequestSchema>;
export type ChangeSystemUserRoleRequest = z.infer<typeof ChangeSystemUserRoleRequestSchema>;

/**
 * Lambda 全体で module-scope に作る Cognito client (= warm invoke で connection pool 再利用)。
 * `CONTROL_PLANE_USER_POOL_ID` env が空なら handler が 503 を返すので、 client 自体は常に
 * 作っておく (= 起動 fail-fast を避ける)。
 */
const cognitoClient = new CognitoIdentityProviderClient({});

function resolveSystemUserPool(): SystemUserClientDeps | undefined {
  const userPoolId = process.env.CONTROL_PLANE_USER_POOL_ID;
  if (!userPoolId || userPoolId.length === 0) return undefined;
  return { client: cognitoClient, userPoolId };
}

function notConfigured(): SystemUsersRouteResult {
  return {
    status: 503,
    body: {
      error: "control_plane_user_pool_unconfigured",
      message: "CONTROL_PLANE_USER_POOL_ID env が未設定です (= stack 配線漏れ)",
    },
  };
}

export async function routeListSystemUsers(c: Context): Promise<SystemUsersRouteResult> {
  const pool = resolveSystemUserPool();
  if (!pool) return notConfigured();
  const items = await listSystemUsers(pool);
  return { status: 200, body: { items } };
}

export async function routeGetSystemUser(
  _c: Context,
  username: string,
): Promise<SystemUsersRouteResult> {
  const pool = resolveSystemUserPool();
  if (!pool) return notConfigured();
  try {
    const user = await getSystemUser(pool, username);
    return { status: 200, body: user };
  } catch (err) {
    if (err instanceof SystemUserNotFoundError) {
      return { status: 404, body: { error: "not_found", username } };
    }
    throw err;
  }
}

export async function routeCreateSystemUser(
  _c: Context,
  request: InviteSystemUserRequest,
): Promise<SystemUsersRouteResult> {
  const pool = resolveSystemUserPool();
  if (!pool) return notConfigured();
  try {
    const user = await createSystemUser(pool, request);
    return { status: 201, body: user };
  } catch (err) {
    if (err instanceof DuplicateSystemUserError) {
      return { status: 409, body: { error: "duplicate_user", email: err.email } };
    }
    throw err;
  }
}

export async function routeChangeSystemUserRole(
  c: Context,
  username: string,
  request: ChangeSystemUserRoleRequest,
): Promise<SystemUsersRouteResult> {
  const pool = resolveSystemUserPool();
  if (!pool) return notConfigured();
  // Lock-out 防止: 自分自身を SystemAuditor に降格する経路を拒否する (= write 権限を失う)。
  // sub では username に変換できないので、 まず getSystemUser で検証 user の email を取り、
  // それと caller の email claim を比較する。 簡素化のため username 同値比較を採用 (= AdminCreateUser
  // で Username=email を使う本 stack の規約に依存)。
  const callerSub = resolveCognitoSub(c);
  if (callerSub === username || isSameAsCaller(c, username)) {
    if (request.role === SYSTEM_AUDITOR_GROUP) {
      return {
        status: 409,
        body: {
          error: "cannot_demote_self",
          message: "lock-out 防止のため自分自身を SystemAuditor に降格できません",
        },
      };
    }
  }
  try {
    await updateSystemUserRole(pool, username, request.role);
    return { status: 200, body: { username, role: request.role } };
  } catch (err) {
    if (err instanceof SystemUserNotFoundError) {
      return { status: 404, body: { error: "not_found", username } };
    }
    throw err;
  }
}

export async function routeDeleteSystemUser(
  c: Context,
  username: string,
): Promise<SystemUsersRouteResult> {
  const pool = resolveSystemUserPool();
  if (!pool) return notConfigured();
  const callerSub = resolveCognitoSub(c);
  if (callerSub === username || isSameAsCaller(c, username)) {
    return {
      status: 409,
      body: { error: "cannot_delete_self", message: "lock-out 防止のため自分自身は削除できません" },
    };
  }
  try {
    await deleteSystemUser(pool, username);
    return { status: 200, body: { deleted: true, username } };
  } catch (err) {
    if (err instanceof SystemUserNotFoundError) {
      return { status: 404, body: { error: "not_found", username } };
    }
    throw err;
  }
}

/**
 * JWT claims から caller の username (= Cognito `cognito:username` claim、 通常 email) を取って
 * target username と一致するか判定する。 sub だけでは Cognito Username にならない (= AdminCreateUser
 * で Username=email を使う本 stack の規約) ため、 sub と username 両方を見る defense-in-depth。
 */
function isSameAsCaller(c: Context, username: string): boolean {
  const event = (c.env as { event?: { requestContext?: { authorizer?: unknown } } } | undefined)
    ?.event;
  const authorizer = event?.requestContext?.authorizer as
    | { jwt?: { claims?: Record<string, unknown> }; claims?: Record<string, unknown> }
    | undefined;
  const claims = authorizer?.jwt?.claims ?? authorizer?.claims;
  if (!claims) return false;
  const callerUsername = claims["cognito:username"];
  if (typeof callerUsername === "string" && callerUsername === username) return true;
  const callerEmail = claims["email"];
  return typeof callerEmail === "string" && callerEmail === username;
}

export {
  SYSTEM_ADMIN_GROUP as SYSTEM_ADMIN_ROLE_VALUE,
  SYSTEM_AUDITOR_GROUP as SYSTEM_AUDITOR_ROLE_VALUE,
};
