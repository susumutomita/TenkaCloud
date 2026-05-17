import type { ApiClient } from "./client";

/**
 * Issue #925 Phase 1: Tenant Admin が tenant 内 user を CRUD する client。 backend は
 * \`competitor-accounts\` Lambda に相乗りしているが、 frontend からは独立 client として扱う。
 */

export interface TenantUserSummary {
  readonly username: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly status?: string;
  readonly createdAt?: string;
  readonly tenantId?: string;
  readonly userRole?: string;
}

/**
 * ADR-020 / Issue #926 Phase B: 招待時に選べる role は 3 種類。 Phase B.1 で route 単位の
 * granular role check が入るまで middleware は TenantAdmin gate を維持するため、 Operator /
 * Viewer は招待しても現状 admin 系 route 越しでは 403。 Phase B.1 で解放される。
 */
export type TenantRole = "TenantAdmin" | "TenantOperator" | "TenantViewer";
export const TENANT_ROLE_OPTIONS: ReadonlyArray<TenantRole> = [
  "TenantAdmin",
  "TenantOperator",
  "TenantViewer",
];

export interface InviteUserInput {
  readonly email: string;
  readonly userRole?: TenantRole;
}

export async function listTenantUsers(api: ApiClient): Promise<TenantUserSummary[]> {
  const res = await api.get<{ items: TenantUserSummary[] }>("admin/users");
  return res.items;
}

export async function inviteTenantUser(
  api: ApiClient,
  body: InviteUserInput,
): Promise<TenantUserSummary> {
  return api.post<TenantUserSummary>("admin/users", body);
}

export async function deleteTenantUser(api: ApiClient, username: string): Promise<void> {
  // username は email 形式が来るので URL-safe に encode する。
  await api.del(`admin/users/${encodeURIComponent(username)}`);
}

/**
 * Issue #17: 既存 user の role を変更する。 backend が AdminUpdateUserAttributes で
 * \`custom:userRole\` を書き換える。 self-target は 409 cannot_change_own_role。
 */
export async function changeTenantUserRole(
  api: ApiClient,
  username: string,
  userRole: TenantRole,
): Promise<{ username: string; userRole: TenantRole }> {
  return api.patch<{ username: string; userRole: TenantRole }>(
    `admin/users/${encodeURIComponent(username)}`,
    { userRole },
  );
}
