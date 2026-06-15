import type { ApiClient } from "./client";

export type TenantUserRole = "TenantAdmin" | "TenantOperator" | "TenantViewer";

export interface TenantUserSummary {
  readonly username: string;
  readonly email?: string;
  readonly role?: TenantUserRole;
  readonly enabled: boolean;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ListTenantUsersResponse {
  readonly items: readonly TenantUserSummary[];
}

export interface InviteTenantUserRequest {
  readonly email: string;
  readonly role: TenantUserRole;
}

export interface TenantUserResponse {
  readonly item: TenantUserSummary;
}

export async function listTenantUsers(api: ApiClient): Promise<ListTenantUsersResponse> {
  return api.get<ListTenantUsersResponse>("admin/users");
}

export async function inviteTenantUser(
  api: ApiClient,
  body: InviteTenantUserRequest,
): Promise<TenantUserResponse> {
  return api.post<TenantUserResponse>("admin/users", body);
}

export async function deleteTenantUser(api: ApiClient, username: string): Promise<void> {
  return api.del(`admin/users/${encodeURIComponent(username)}`);
}

export async function changeTenantUserRole(
  api: ApiClient,
  username: string,
  role: TenantUserRole,
): Promise<TenantUserResponse> {
  return api.patch<TenantUserResponse>(`admin/users/${encodeURIComponent(username)}`, { role });
}
