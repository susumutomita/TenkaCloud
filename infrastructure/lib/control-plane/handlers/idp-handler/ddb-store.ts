/**
 * DDB-backed {@link IdpStore} (Issues #1293 / #1294).
 *
 * Table shape (`SamlIdps`):
 *   - PK: `${scope}#${idpId}` where `scope` is `SYSTEM` (Control Plane) or the
 *     tenantId (Application Plane). The Control Plane stack and the per-tenant
 *     stack each own their own table — they do not share storage.
 *
 *   - `idpId` is also stored as a top-level attribute for hydration.
 *
 * No GSI — list queries are bounded by `SAML_IDP_LIMIT_PER_USERPOOL` (25) and
 * a single Query call per scope suffices.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import type { IdpScope, IdpStore } from "./core.js";

const SYSTEM_SCOPE_KEY = "SYSTEM";

export interface DdbIdpStoreOptions {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
}

export function createDdbIdpStore(opts: DdbIdpStoreOptions): IdpStore {
  return {
    async list(scope: IdpScope): Promise<readonly SamlIdpConfig[]> {
      const pkPrefix = scopePkPrefix(scope);
      const res = await opts.ddb.send(
        new QueryCommand({
          TableName: opts.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pkPrefix },
        }),
      );
      const items = (res.Items ?? []) as Array<Record<string, unknown>>;
      return items.map(hydrate);
    },
    async get(scope: IdpScope, idpId: string): Promise<SamlIdpConfig | null> {
      const res = await opts.ddb.send(
        new GetCommand({
          TableName: opts.tableName,
          Key: { pk: scopePkPrefix(scope), sk: idpId },
        }),
      );
      if (!res.Item) return null;
      return hydrate(res.Item as Record<string, unknown>);
    },
    async put(scope: IdpScope, config: SamlIdpConfig): Promise<void> {
      await opts.ddb.send(
        new PutCommand({
          TableName: opts.tableName,
          Item: {
            pk: scopePkPrefix(scope),
            sk: config.idpId,
            ...config,
          },
        }),
      );
    },
    async delete(scope: IdpScope, idpId: string): Promise<void> {
      await opts.ddb.send(
        new DeleteCommand({
          TableName: opts.tableName,
          Key: { pk: scopePkPrefix(scope), sk: idpId },
        }),
      );
    },
  };
}

function scopePkPrefix(scope: IdpScope): string {
  return scope.kind === "system" ? SYSTEM_SCOPE_KEY : scope.tenantId;
}

function hydrate(item: Record<string, unknown>): SamlIdpConfig {
  // Drop DDB-only keys before returning to caller.
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as unknown as SamlIdpConfig;
}
