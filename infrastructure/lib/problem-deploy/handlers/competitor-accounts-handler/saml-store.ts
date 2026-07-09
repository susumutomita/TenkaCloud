import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { SamlConfigRecord } from "../../control-data/types.js";
import type { TenantSamlConfigInput, TenantSamlConfigView } from "./saml-types.js";

/**
 * Issue #839 follow-up Phase B / [Issue #2442 Phase C2]: Tenant SAML 設定の永続化層。
 *
 * CompetitorAccounts table (= 既存 PK=`TENANT#<tenantId>` partition) を再利用し、 sparse な
 * `SK="SAML_CONFIG"` 行 1 つを per-tenant で持つ。 Cognito UserPool 側の真実 (= IdP / Client
 * config) は Cognito API から describe で取れるが、 UI が「最後に保存された設定」 を高速に
 * 表示するための写しとして DDB を使う (= Cognito API は 5 RPS quota がある + 数 100ms かかる)。
 *
 * 生の DDB access はここには無い — `controlDataRuntime.resolveSamlConfigRepository` 経由で
 * {@link DynamoDbSamlConfigRepository} (default) / {@link SqlSamlConfigRepository} (Turso/D1)
 * を解決する。**`SAML_CONFIG` 行は `SamlIdps` テーブル (#1312, Lite 専用の別物) とは無関係** —
 * 混同しないこと。
 */

export interface SamlStoreDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

function toView(record: SamlConfigRecord): TenantSamlConfigView {
  const hasCore = record.metadataUrl.length > 0 && record.providerName.length > 0;
  return {
    enabled: hasCore,
    metadataUrl: record.metadataUrl,
    providerName: record.providerName,
    attributeMapping: record.attributeMapping,
    enforceSamlOnly: record.enforceSamlOnly,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/**
 * 現在の SAML config を返す (= 未保存なら undefined)。 GET endpoint の主経路。
 */
export async function getTenantSamlConfig(
  deps: SamlStoreDeps,
  tenantId: string,
): Promise<TenantSamlConfigView | undefined> {
  const repository = await controlDataRuntime.resolveSamlConfigRepository({
    ddb: deps.ddb as DynamoDBDocumentClient,
    competitorAccountsTableName: deps.tableName,
  });
  const record = await repository.getSamlConfig(tenantId);
  return record ? toView(record) : undefined;
}

/**
 * SAML config を upsert する (= PUT endpoint の DDB write 部)。 Cognito 側の更新成功後に呼ぶ。
 * `updatedAt` は caller (handler) が runtime now を渡す (= test 注入用)。
 */
export async function putTenantSamlConfig(
  deps: SamlStoreDeps,
  tenantId: string,
  input: TenantSamlConfigInput & { readonly providerName: string },
  meta: { readonly updatedAt: string; readonly updatedBy: string },
): Promise<TenantSamlConfigView> {
  const record: SamlConfigRecord = {
    tenantId,
    metadataUrl: input.metadataUrl,
    providerName: input.providerName,
    attributeMapping: input.attributeMapping ?? {},
    enforceSamlOnly: input.enforceSamlOnly ?? false,
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  };
  const repository = await controlDataRuntime.resolveSamlConfigRepository({
    ddb: deps.ddb as DynamoDBDocumentClient,
    competitorAccountsTableName: deps.tableName,
  });
  const written = await repository.putSamlConfig(record);
  return toView(written);
}

/**
 * SAML config を削除する (= DELETE endpoint の DDB 部)。 不在なら no-op (= idempotent)。
 */
export async function deleteTenantSamlConfig(deps: SamlStoreDeps, tenantId: string): Promise<void> {
  const repository = await controlDataRuntime.resolveSamlConfigRepository({
    ddb: deps.ddb as DynamoDBDocumentClient,
    competitorAccountsTableName: deps.tableName,
  });
  await repository.deleteSamlConfig(tenantId);
}
