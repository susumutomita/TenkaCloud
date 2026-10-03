import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { tenantFlagsKey } from "../handlers/shared/tenant-feature-flags.js";
import type { FeatureFlagsRepository, TenantFeatureFlagsRecord } from "./types.js";

const DDB_KEY_ATTRS: ReadonlySet<string> = new Set(["PK", "SK"]);

function itemToRecord(item: Record<string, unknown>): TenantFeatureFlagsRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as TenantFeatureFlagsRecord;
}

export class DynamoDbFeatureFlagsRepository implements FeatureFlagsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({ TableName: this.tableName, Key: tenantFlagsKey(tenantId) }),
    );
    const item = out.Item as Record<string, unknown> | undefined;
    return item ? itemToRecord(item) : undefined;
  }

  async put(record: TenantFeatureFlagsRecord): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...tenantFlagsKey(record.tenantId), ...record },
      }),
    );
  }
}
