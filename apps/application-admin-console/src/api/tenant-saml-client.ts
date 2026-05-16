import type { ApiClient } from "./client";

/**
 * Issue #839 follow-up Phase B: Tenant 管理者が画面 / API から自社 SAML IdP を CRUD する
 * client。 backend は `competitor-accounts` Lambda に同居しているが、 frontend からは独立した
 * 概念として扱うため client を分けている。
 */

export interface TenantSamlConfigView {
  readonly enabled: boolean;
  readonly metadataUrl?: string;
  readonly providerName?: string;
  readonly attributeMapping?: Readonly<Record<string, string>>;
  readonly enforceSamlOnly?: boolean;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export interface TenantSamlConfigInput {
  readonly metadataUrl: string;
  readonly providerName?: string;
  readonly attributeMapping?: Readonly<Record<string, string>>;
  readonly enforceSamlOnly?: boolean;
}

export async function getTenantSamlConfig(api: ApiClient): Promise<TenantSamlConfigView> {
  return api.get<TenantSamlConfigView>("admin/tenant-saml-config");
}

/**
 * SAML config を upsert する。 backend が Cognito IdP CRUD + UserPoolClient mutation + DDB
 * persist を 1 リクエストで行う。 enforceSamlOnly=true に flip するときは UI 側で 2-step
 * 確認 modal を表示してから呼ぶこと。
 */
export async function putTenantSamlConfig(
  api: ApiClient,
  body: TenantSamlConfigInput,
): Promise<TenantSamlConfigView> {
  // ApiClient に PUT が無いので fetch を直接組む (= 既存 patch / post と同形を踏襲)。
  return api.patch<TenantSamlConfigView>("admin/tenant-saml-config", body);
}

export async function deleteTenantSamlConfig(api: ApiClient): Promise<void> {
  return api.del("admin/tenant-saml-config");
}
