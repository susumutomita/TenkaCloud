import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploySharedResources } from "./deploy.js";
import type { DeploymentItem, DeploymentStatus } from "./types.js";

export interface DeploymentSummary {
  readonly jobId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly region: string;
  /**
   * Operator が deploy form で入力した内部 slug。CFn StackName の由来 (`namePrefix`)
   * になっていて、deploy 後は変更不可。Operator UI 上は「内部 slug」として表示する。
   */
  readonly teamName: string;
  /**
   * 競技者が portal `PATCH /portal/me` で設定した表示用チーム名。Operator UI 上は
   * 「表示名 (競技者選択)」として表示し、未設定なら undefined。
   */
  readonly displayTeamName?: string;
  readonly namePrefix: string;
  readonly status: DeploymentStatus;
  readonly stackId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
}

export interface ListDeploymentsRequest {
  readonly tenantId: string;
  readonly problemId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListDeploymentsResponse {
  readonly items: readonly DeploymentSummary[];
  readonly nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * `teamLoginKey` (短命 bearer) や `dbPassword` (CFn Parameter) など、リスト/詳細
 * 表示で出してはいけないフィールドを落とす。新しい sensitive フィールドが増えたら
 * ここに追加する。
 */
export function toSummary(item: Partial<DeploymentItem>): DeploymentSummary {
  return {
    jobId: String(item.jobId ?? ""),
    problemId: String(item.problemId ?? ""),
    tenantId: String(item.tenantId ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    region: String(item.region ?? ""),
    teamName: String(item.teamName ?? ""),
    displayTeamName: typeof item.displayTeamName === "string" ? item.displayTeamName : undefined,
    namePrefix: String(item.namePrefix ?? ""),
    status: (item.status ?? "PENDING") as DeploymentStatus,
    stackId: item.stackId,
    stackOutputs: item.stackOutputs,
    failureReason: item.failureReason,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
  };
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 不正な cursor は undefined として最初から開始
  }
  return undefined;
}

/**
 * 指定 tenant の Deployment 一覧を新しい順に返す。`problemId` が指定されたら
 * GSI1 query 後に in-memory で絞り込む (テナント当たりの行数が小さい前提)。
 */
export async function listDeployments(
  shared: DeploySharedResources,
  request: ListDeploymentsRequest,
): Promise<ListDeploymentsResponse> {
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const exclusiveStartKey = request.cursor ? decodeCursor(request.cursor) : undefined;

  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `TENANT#${request.tenantId}` },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const raw = (out.Items ?? []) as Partial<DeploymentItem>[];
  const filtered = request.problemId ? raw.filter((i) => i.problemId === request.problemId) : raw;
  const items = filtered.map(toSummary);
  const nextCursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey as Record<string, unknown>)
    : undefined;
  return { items, nextCursor };
}

/**
 * 指定 jobId の Deployment 1 件を返す。`tenantId` が caller と一致しない行は
 * クロステナント漏洩防止のため `undefined` を返す (404 相当)。
 */
export async function getDeployment(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
): Promise<DeploymentSummary | undefined> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = out.Item as Partial<DeploymentItem> | undefined;
  if (!item) return undefined;
  if (item.tenantId !== tenantId) return undefined;
  return toSummary(item);
}
