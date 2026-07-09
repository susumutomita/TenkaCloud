import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CompetitorAccountItem } from "../handlers/competitor-accounts-handler/types.js";
import type {
  CompetitorAccountMutationOutcome,
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
  CreateCompetitorAccountOutcome,
} from "./types.js";

/**
 * [Issue #2442 / Phase C2] DynamoDB implementation of {@link CompetitorAccountsRepository}.
 * A behavior-preserving extraction of the DDB access
 * `handlers/competitor-accounts-handler/store.ts` previously performed
 * inline: the SAME table, keys, `ConditionExpression` / `UpdateExpression` /
 * `ProjectionExpression`, and marshalling. It is the default backend —
 * flipping to SQLite is a one-flag rollback (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `competitor-accounts-table.ts`):
 *   PK = `TENANT#<tenantId>` / SK = `ACCOUNT#<awsAccountId>`
 * No GSI — `listAccounts` / `hasRemainingAccounts` scope to the base table via
 * `begins_with(SK, "ACCOUNT#")`.
 */
const PK = (tenantId: string) => `TENANT#${tenantId}`;
const SK = (awsAccountId: string) => `ACCOUNT#${awsAccountId}`;
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set(["PK", "SK"]);

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/** Strip the two physical DDB keys, yielding the domain {@link CompetitorAccountRecord}. */
function itemToRecord(item: Record<string, unknown>): CompetitorAccountRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as CompetitorAccountRecord;
}

export class DynamoDbCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createAccount(record: CompetitorAccountRecord): Promise<CreateCompetitorAccountOutcome> {
    const item = { PK: PK(record.tenantId), SK: SK(record.awsAccountId), ...record };
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "conflict" };
      throw err;
    }
    return { outcome: "created" };
  }

  async listAccounts(tenantId: string): Promise<readonly CompetitorAccountRecord[]> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": PK(tenantId), ":sk": "ACCOUNT#" },
      }),
    );
    return ((out.Items ?? []) as Record<string, unknown>[]).map(itemToRecord);
  }

  async getAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountRecord | undefined> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
      }),
    );
    return out.Item ? itemToRecord(out.Item as Record<string, unknown>) : undefined;
  }

  async markVerified(
    tenantId: string,
    awsAccountId: string,
    verifiedAt: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    try {
      const out = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
          UpdateExpression: "SET verified = :v, verifiedAt = :va, updatedAt = :ua",
          ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
          ExpressionAttributeValues: { ":v": true, ":va": verifiedAt, ":ua": verifiedAt },
          ReturnValues: "ALL_NEW",
        }),
      );
      return {
        outcome: "updated",
        record: itemToRecord((out.Attributes ?? {}) as Record<string, unknown>),
      };
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "not_found" };
      throw err;
    }
  }

  async deleteAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    try {
      await this.ddb.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
          ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return { outcome: "not_found" };
      throw err;
    }
    return { outcome: "updated" };
  }

  async hasRemainingAccounts(tenantId: string): Promise<boolean> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": PK(tenantId), ":sk": "ACCOUNT#" },
        Select: "COUNT",
        Limit: 1,
      }),
    );
    return (out.Count ?? 0) > 0;
  }

  async forEachCompetitorAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountItem>[]) => Promise<void>,
  ): Promise<void> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await this.ddb.send(
        new ScanCommand({
          TableName: this.tableName,
          ProjectionExpression: "tenantId, awsAccountId, rotatedAt, createdAt",
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      await onPage((out.Items ?? []) as Partial<CompetitorAccountItem>[]);
      exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  }
}
