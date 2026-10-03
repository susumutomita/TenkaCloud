import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SamlConfigRecord, SamlConfigRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C2] DynamoDB implementation of {@link SamlConfigRepository}.
 * A behavior-preserving extraction of the DDB access
 * `handlers/competitor-accounts-handler/saml-store.ts` previously performed
 * inline: the SAME CompetitorAccounts table + sparse `SK = "SAML_CONFIG"` row,
 * byte-identical `Item` shape (PK/SK plus the 6 config attributes — `tenantId`
 * itself is never written as a redundant attribute, matching the pre-seam
 * `DdbRow`).
 *
 * Physical shape (unchanged, `competitor-accounts-table.ts`):
 *   PK = `TENANT#<tenantId>` (shared partition with CompetitorAccounts rows)
 *   SK = `SAML_CONFIG` (sparse, 1 row per tenant)
 */
const SK_SAML_CONFIG = "SAML_CONFIG";
const pk = (tenantId: string) => `TENANT#${tenantId}`;

interface DdbRow {
  metadataUrl: string;
  providerName: string;
  attributeMapping: Record<string, string>;
  enforceSamlOnly: boolean;
  updatedAt: string;
  updatedBy: string;
}

export class DynamoDbSamlConfigRepository implements SamlConfigRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getSamlConfig(tenantId: string): Promise<SamlConfigRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: pk(tenantId), SK: SK_SAML_CONFIG },
      }),
    );
    if (!out.Item) return undefined;
    const row = out.Item as Partial<DdbRow>;
    return {
      tenantId,
      metadataUrl: String(row.metadataUrl ?? ""),
      providerName: String(row.providerName ?? ""),
      attributeMapping: row.attributeMapping ?? {},
      enforceSamlOnly: row.enforceSamlOnly === true,
      updatedAt: String(row.updatedAt ?? ""),
      updatedBy: String(row.updatedBy ?? ""),
    };
  }

  async putSamlConfig(record: SamlConfigRecord): Promise<SamlConfigRecord> {
    const { tenantId, ...attrs } = record;
    const item: DdbRow & { PK: string; SK: string } = {
      PK: pk(tenantId),
      SK: SK_SAML_CONFIG,
      ...attrs,
    };
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
    return record;
  }

  async deleteSamlConfig(tenantId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: pk(tenantId), SK: SK_SAML_CONFIG },
      }),
    );
  }
}
