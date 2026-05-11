import type { SSMClient } from "@aws-sdk/client-ssm";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { deleteExternalId, ensureExternalId } from "../shared/external-id-store.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import type {
  CompetitorAccountItem,
  CompetitorAccountSummary,
  CreateCompetitorAccountRequest,
  CreateCompetitorAccountResponse,
} from "./types.js";

const PK = (tenantId: string) => `TENANT#${tenantId}`;
const SK = (awsAccountId: string) => `ACCOUNT#${awsAccountId}`;

const toSummary = (item: Partial<CompetitorAccountItem>): CompetitorAccountSummary => ({
  awsAccountId: String(item.awsAccountId ?? ""),
  region: String(item.region ?? "ap-northeast-1"),
  competitorRoleName: String(item.competitorRoleName ?? ""),
  alias: typeof item.alias === "string" ? item.alias : undefined,
  verified: item.verified === true,
  verifiedAt: typeof item.verifiedAt === "string" ? item.verifiedAt : undefined,
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? ""),
});

export class DuplicateCompetitorAccountError extends Error {
  constructor(public readonly awsAccountId: string) {
    super(`competitor account ${awsAccountId} is already registered for this tenant`);
    this.name = "DuplicateCompetitorAccountError";
  }
}

export class CompetitorAccountNotFoundError extends Error {
  constructor(public readonly awsAccountId: string) {
    super(`competitor account ${awsAccountId} is not registered for this tenant`);
    this.name = "CompetitorAccountNotFoundError";
  }
}

export interface CreateCompetitorAccountContext {
  readonly tenantId: string;
  readonly nowMs: number;
  readonly createdBy: string;
}

/**
 * `(tenantId, awsAccountId)` の新規登録。
 *
 * 1. SSM の tenant ExternalId を冪等に確保 (= 既存なら回さない、未登録なら 64 文字 hex を発行)
 * 2. DDB に行を Put — 同 (PK, SK) があれば `DuplicateCompetitorAccountError`
 * 3. 戻り値に `externalId` / `tenkaCloudAccountId` を **1 度だけ** 露出 (一覧 API には載せない)
 */
export async function createCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  ctx: CreateCompetitorAccountContext,
  req: CreateCompetitorAccountRequest,
): Promise<CreateCompetitorAccountResponse> {
  const { externalId } = await ensureExternalId(
    { ssm: shared.ssm as SSMClient, env: shared.env },
    ctx.tenantId,
  );

  const nowIso = new Date(ctx.nowMs).toISOString();
  const item: CompetitorAccountItem = {
    PK: PK(ctx.tenantId),
    SK: SK(req.awsAccountId),
    tenantId: ctx.tenantId,
    awsAccountId: req.awsAccountId,
    region: req.region,
    competitorRoleName: req.competitorRoleName,
    ...(req.alias !== undefined ? { alias: req.alias } : {}),
    verified: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: ctx.createdBy,
  };
  try {
    await shared.ddb.send(
      new PutCommand({
        TableName: shared.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }),
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "ConditionalCheckFailedException") {
      throw new DuplicateCompetitorAccountError(req.awsAccountId);
    }
    throw err;
  }

  return {
    ...toSummary(item),
    externalId,
    tenkaCloudAccountId: shared.tenkaCloudAccountId,
  };
}

/** tenant 内の全 competitor account を一覧する (= verified / unverified 両方)。 */
export async function listCompetitorAccounts(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
): Promise<readonly CompetitorAccountSummary[]> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": PK(tenantId),
        ":sk": "ACCOUNT#",
      },
    }),
  );
  return (out.Items ?? []).map((it) => toSummary(it as Partial<CompetitorAccountItem>));
}

export async function getCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
  awsAccountId: string,
): Promise<CompetitorAccountSummary | undefined> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
    }),
  );
  if (!out.Item) return undefined;
  return toSummary(out.Item as Partial<CompetitorAccountItem>);
}

export interface MarkVerifiedContext {
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly verifiedAt: string;
}

/**
 * `verified=true` + `verifiedAt` を 1 回 Update。row が無ければ `CompetitorAccountNotFoundError`。
 *
 * caller (handler) は STS AssumeRole が成功した後にのみ呼ぶこと。
 */
export async function markCompetitorAccountVerified(
  shared: CompetitorAccountsSharedResources,
  ctx: MarkVerifiedContext,
): Promise<CompetitorAccountSummary> {
  try {
    const out = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: PK(ctx.tenantId), SK: SK(ctx.awsAccountId) },
        UpdateExpression: "SET verified = :v, verifiedAt = :va, updatedAt = :ua",
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
        ExpressionAttributeValues: {
          ":v": true,
          ":va": ctx.verifiedAt,
          ":ua": ctx.verifiedAt,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return toSummary((out.Attributes ?? {}) as Partial<CompetitorAccountItem>);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "ConditionalCheckFailedException") {
      throw new CompetitorAccountNotFoundError(ctx.awsAccountId);
    }
    throw err;
  }
}

/**
 * row を削除。**同 tenant の最後の row** だった場合は SSM の ExternalId も削除する (= clean rotation)。
 *
 * 既に存在しない row の DELETE は idempotent: 削除前に `getCompetitorAccount` で確認し、
 * 無ければ `CompetitorAccountNotFoundError`。
 */
export async function deleteCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
  awsAccountId: string,
): Promise<void> {
  // 削除前に存在確認 (= 404 を caller が返せるように)。
  const existing = await getCompetitorAccount(shared, tenantId, awsAccountId);
  if (!existing) throw new CompetitorAccountNotFoundError(awsAccountId);

  await shared.ddb.send(
    new DeleteCommand({
      TableName: shared.tableName,
      Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
    }),
  );

  // 残り行を確認し、tenant に 1 行も無くなれば SSM の ExternalId も掃除する (= 鍵漏洩リスク減)。
  const remaining = await listCompetitorAccounts(shared, tenantId);
  if (remaining.length === 0) {
    await deleteExternalId({ ssm: shared.ssm as SSMClient, env: shared.env }, tenantId);
  }
}
