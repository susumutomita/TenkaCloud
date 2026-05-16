import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { TenantSamlConfigInput, TenantSamlConfigView } from "./saml-types.js";

/**
 * Issue #839 follow-up Phase B: Tenant SAML 設定の DDB persistence 層。
 *
 * CompetitorAccounts table (= 既存 PK=`TENANT#<tenantId>` partition) を再利用し、 sparse な
 * `SK="SAML_CONFIG"` 行 1 つを per-tenant で持つ。 Cognito UserPool 側の真実 (= IdP / Client
 * config) は Cognito API から describe で取れるが、 UI が「最後に保存された設定」 を高速に
 * 表示するための写しとして DDB を使う (= Cognito API は 5 RPS quota がある + 数 100ms かかる)。
 *
 * shape:
 *   PK = `TENANT#<tenantId>` (= 既存 partition と相乗り)
 *   SK = `SAML_CONFIG` (= sparse, 1 tenant 1 行)
 *   metadataUrl: string
 *   providerName: string
 *   attributeMapping: map<string, string>
 *   enforceSamlOnly: boolean
 *   updatedAt: ISO 8601
 *   updatedBy: cognito sub (= 監査用)
 */

const SK_SAML_CONFIG = "SAML_CONFIG";

export interface SamlStoreDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly tableName: string;
}

function pk(tenantId: string): string {
  return `TENANT#${tenantId}`;
}

/**
 * 現在の SAML config を返す (= 未保存なら undefined)。 GET endpoint の主経路。
 */
export async function getTenantSamlConfig(
  deps: SamlStoreDeps,
  tenantId: string,
): Promise<TenantSamlConfigView | undefined> {
  const out = await deps.ddb.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { PK: pk(tenantId), SK: SK_SAML_CONFIG },
    }),
  );
  const item = out.Item as Partial<DdbRow> | undefined;
  if (!item) return undefined;
  return rowToView(item);
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
  const row: DdbRow = {
    PK: pk(tenantId),
    SK: SK_SAML_CONFIG,
    metadataUrl: input.metadataUrl,
    providerName: input.providerName,
    attributeMapping: input.attributeMapping ?? {},
    enforceSamlOnly: input.enforceSamlOnly ?? false,
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  };
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: row,
    }),
  );
  return rowToView(row);
}

/**
 * SAML config を削除する (= DELETE endpoint の DDB 部)。 不在なら no-op (= idempotent)。
 */
export async function deleteTenantSamlConfig(deps: SamlStoreDeps, tenantId: string): Promise<void> {
  await deps.ddb.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { PK: pk(tenantId), SK: SK_SAML_CONFIG },
    }),
  );
}

interface DdbRow {
  PK: string;
  SK: string;
  metadataUrl: string;
  providerName: string;
  attributeMapping: Record<string, string>;
  enforceSamlOnly: boolean;
  updatedAt: string;
  updatedBy: string;
}

function rowToView(row: Partial<DdbRow>): TenantSamlConfigView {
  // 行が存在しても enabled は metadataUrl + providerName が揃っているときのみ true。
  // 不正な partial row (= 旧 schema migration 中) は disabled 扱いで安全に倒す。
  const hasCore =
    typeof row.metadataUrl === "string" &&
    row.metadataUrl.length > 0 &&
    typeof row.providerName === "string" &&
    row.providerName.length > 0;
  return {
    enabled: hasCore,
    metadataUrl: row.metadataUrl,
    providerName: row.providerName,
    attributeMapping: row.attributeMapping,
    enforceSamlOnly: row.enforceSamlOnly,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
