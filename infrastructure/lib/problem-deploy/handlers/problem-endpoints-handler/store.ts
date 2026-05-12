import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { buildEndpointPK, buildEndpointSK } from "../../problem-endpoints-table.js";

/**
 * 1 (tenant, team, problem, slot) を表す DDB 行の最小 shape。
 *
 * `defaultCacheUrl` は Phase 3.A 時点では未使用 (= read-through 算出)。Phase 3.B で
 * deploy 完了 hook が書き込む余地を残す。
 */
export interface EndpointOverrideItem {
  PK: string;
  SK: string;
  tenantId: string;
  teamId: string;
  problemId: string;
  slot: string;
  overrideUrl?: string;
  defaultCacheUrl?: string;
  platform?: string;
  updatedAt: string;
}

export interface PutOverrideArgs {
  tenantId: string;
  teamId: string;
  problemId: string;
  slot: string;
  overrideUrl: string;
  nowIso: string;
}

export async function putOverride(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  args: PutOverrideArgs,
): Promise<EndpointOverrideItem> {
  const item: EndpointOverrideItem = {
    PK: buildEndpointPK(args.tenantId, args.teamId, args.problemId),
    SK: buildEndpointSK(args.slot),
    tenantId: args.tenantId,
    teamId: args.teamId,
    problemId: args.problemId,
    slot: args.slot,
    overrideUrl: args.overrideUrl,
    updatedAt: args.nowIso,
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
  return item;
}

export interface DeleteOverrideArgs {
  tenantId: string;
  teamId: string;
  problemId: string;
  slot: string;
}

export async function deleteOverride(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  args: DeleteOverrideArgs,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: buildEndpointPK(args.tenantId, args.teamId, args.problemId),
        SK: buildEndpointSK(args.slot),
      },
    }),
  );
}

export async function queryOverrides(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  teamId: string,
  problemId: string,
): Promise<EndpointOverrideItem[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": buildEndpointPK(tenantId, teamId, problemId),
        ":sk": "SLOT#",
      },
    }),
  );
  return (out.Items ?? []) as EndpointOverrideItem[];
}
