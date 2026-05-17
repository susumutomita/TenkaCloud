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

export interface InviteUserInput {
  readonly email: string;
  readonly userRole?: "TenantAdmin";
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
