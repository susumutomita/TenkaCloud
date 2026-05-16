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
  readonly buildId?: string;
  readonly stackOutputs?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  /**
   * チーム共有ログインキー (短命 bearer)。`getDeployment` 経路 (= caller が own tenantId
   * で TenantAdmin 認可済) では返す。`listDeployments` 経路では出さない (= 万が一
   * UI が一覧画面でも誤露出しないよう、複数行スコープでは引かない)。
   */
  readonly teamLoginKey?: string;
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
 * 一覧表示で安全に返せる minimal な shape。`teamLoginKey` のような短命 bearer は
 * 出さない (= 一覧画面で誤露出しない)。`dbPassword` 等の CFn Parameter も同様。
 * 新しい sensitive フィールドが増えたらここに追加する。
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
    buildId: item.buildId,
    stackOutputs: item.stackOutputs,
    failureReason: item.failureReason,
    createdAt: String(item.createdAt ?? ""),
    updatedAt: String(item.updatedAt ?? ""),
    expiresAt: Number(item.expiresAt ?? 0),
  };
}

/**
 * 詳細画面 (`getDeployment`) 専用の shape。`toSummary` に加えて `teamLoginKey` を含める。
 * caller は own tenantId で TenantAdmin 認可済なので、operator が hand-off のため再取得
 * できる必要がある。一覧 (`toSummary`) には含めず、誤露出経路を限定する。
 */
export function toDetail(item: Partial<DeploymentItem>): DeploymentSummary {
  return {
    ...toSummary(item),
    teamLoginKey: typeof item.teamLoginKey === "string" ? item.teamLoginKey : undefined,
  };
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Issue #862: cursor は DDB ExclusiveStartKey にそのまま渡るので、 attacker が任意 shape
 * の JSON を送ると pagination 経路を破壊 / 推測攻撃に使える。 base64 + JSON 形式は保証
 * できるが、 値のセマンティック (= PK が `DEPLOYMENT#<ulid>` / SK が `META` /
 * GSI1 query なので GSI1PK / GSI1SK もあり得る) に絞ったキー allowlist で shape を pin。
 *
 * 不一致なら undefined を返し、 最初から page し直す (= silent reset の方が attacker に
 * 情報を与えない)。
 */
const ALLOWED_CURSOR_KEYS = new Set(["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]);
const MAX_CURSOR_LENGTH = 512;

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH) return undefined;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // 各 key が allowlist 内、 各 value が string であることを pin。 数値 / boolean /
    // ネスト object は弾く (= DDB Key は string-only の運用想定)。
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ALLOWED_CURSOR_KEYS.has(k)) return undefined;
      if (typeof v !== "string" || v.length === 0 || v.length > 256) return undefined;
    }
    return parsed as Record<string, unknown>;
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
  return toDetail(item);
}
