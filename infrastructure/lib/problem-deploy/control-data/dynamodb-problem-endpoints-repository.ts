import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { buildEndpointPK, buildEndpointSK } from "../problem-endpoints-table.js";
import type { ProblemEndpointRecord, ProblemEndpointsRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C1] DynamoDB implementation of {@link ProblemEndpointsRepository}.
 * This is a behavior-preserving extraction of the DDB access
 * `handlers/problem-endpoints-handler/store.ts` and
 * `handlers/generic-scoring-handler/index.ts` (`queryOverridesForDeployment`)
 * previously performed inline: the SAME table, keys, and marshalling. It is the
 * default backend — flipping to SQLite is a one-flag rollback
 * (`CONTROL_DATA_BACKEND`).
 *
 * Physical shape (unchanged, `problem-endpoints-table.ts`):
 *   PK = `TENANT#<tenantId>#TEAM#<teamId>#PROBLEM#<problemId>` / SK = `SLOT#<slot>`
 *
 * No GSI to strip on read — only the base-table PK/SK.
 */
const DDB_KEY_ATTRS: ReadonlySet<string> = new Set(["PK", "SK"]);

/** Strip the two physical DDB keys, yielding the domain {@link ProblemEndpointRecord}. */
function itemToRecord(item: Record<string, unknown>): ProblemEndpointRecord {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (DDB_KEY_ATTRS.has(key)) continue;
    record[key] = value;
  }
  return record as unknown as ProblemEndpointRecord;
}

export class DynamoDbProblemEndpointsRepository implements ProblemEndpointsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async putOverride(record: ProblemEndpointRecord): Promise<void> {
    const item = {
      PK: buildEndpointPK(record.tenantId, record.teamId, record.problemId),
      SK: buildEndpointSK(record.slot),
      ...record,
    };
    await this.ddb.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async deleteOverride(
    tenantId: string,
    teamId: string,
    problemId: string,
    slot: string,
  ): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: buildEndpointPK(tenantId, teamId, problemId),
          SK: buildEndpointSK(slot),
        },
      }),
    );
  }

  async queryOverrides(
    tenantId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly ProblemEndpointRecord[]> {
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": buildEndpointPK(tenantId, teamId, problemId),
          ":sk": "SLOT#",
        },
      }),
    );
    return ((out.Items ?? []) as Record<string, unknown>[]).map(itemToRecord);
  }
}
