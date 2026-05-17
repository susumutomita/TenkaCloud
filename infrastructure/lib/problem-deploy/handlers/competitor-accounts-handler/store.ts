import type { SSMClient } from "@aws-sdk/client-ssm";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  deleteExternalId,
  ensureExternalId,
  getExternalId,
  rotateExternalId,
} from "../shared/external-id-store.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import type {
  CompetitorAccountItem,
  CompetitorAccountSummary,
  CreateCompetitorAccountRequest,
  CreateCompetitorAccountResponse,
  RotateExternalIdResponse,
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
  rotatedAt: typeof item.rotatedAt === "string" ? item.rotatedAt : undefined,
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

/**
 * Issue #868: register 直後 / verify 未完了 (verified=false) の row に対する operation を
 * 拒否するエラー。 `POST /verify` で AssumeRole sanity check が成功するまで、 deploy /
 * rotate などの downstream operation を gate する。
 */
export class CompetitorAccountNotVerifiedError extends Error {
  constructor(public readonly awsAccountId: string) {
    super(
      `competitor account ${awsAccountId} is registered but not yet verified; ` +
        "call POST /admin/competitor-accounts/{awsAccountId}/verify first",
    );
    this.name = "CompetitorAccountNotVerifiedError";
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
 * `ConditionExpression` で行不在を atomic 検出 (= TOCTOU 回避、1 round-trip 削減)。
 * 残行確認は `Select: COUNT` + `Limit: 1` で wire payload を最小化する。
 */
export async function deleteCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
  awsAccountId: string,
): Promise<void> {
  try {
    await shared.ddb.send(
      new DeleteCommand({
        TableName: shared.tableName,
        Key: { PK: PK(tenantId), SK: SK(awsAccountId) },
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      throw new CompetitorAccountNotFoundError(awsAccountId);
    }
    throw err;
  }

  // 残行ゼロなら SSM の ExternalId も掃除する (= 鍵漏洩リスク減)。
  const remaining = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": PK(tenantId), ":sk": "ACCOUNT#" },
      Select: "COUNT",
      Limit: 1,
    }),
  );
  if ((remaining.Count ?? 0) === 0) {
    await deleteExternalId({ ssm: shared.ssm as SSMClient, env: shared.env }, tenantId);
  }
}

export interface RotateExternalIdContext {
  readonly tenantId: string;
  readonly awsAccountId: string;
  readonly nowMs: number;
}

export class ExternalIdMissingForRotationError extends Error {
  constructor(public readonly tenantId: string) {
    super(`external id parameter is missing for tenant ${tenantId}; cannot rotate`);
    this.name = "ExternalIdMissingForRotationError";
  }
}

/**
 * 既存 (tenantId, awsAccountId) に対して ExternalId を rotate (Issue #596 / Phase 3.1)。
 *
 * 手順:
 *  1. DDB の該当 row が存在することを確認 (= row 不在なら `CompetitorAccountNotFoundError`)。
 *  2. SSM の現 ExternalId が存在することを確認 (= 不在は不整合、`ExternalIdMissingForRotationError`)。
 *  3. SSM SecureString を `Overwrite: true` で新 64 文字 hex に上書き
 *     (= SSM 内部で version 履歴が増える)。
 *  4. DDB の `rotatedAt` / `updatedAt` を更新。
 *  5. 新 ExternalId + tenkaCloudAccountId を 1 度だけ返す (= Create と同じ Reveal payload)。
 *
 * 同 tenant 配下の他 account 行も同じ SSM Parameter を共有するため、rotate 直後は **全 account
 * の競技者側 CFn stack の Parameter を update する必要がある**。caller (handler) はその警告を
 * operator に出すこと (= frontend の confirmation modal で文言済み)。
 */
export async function rotateExternalIdForAccount(
  shared: CompetitorAccountsSharedResources,
  ctx: RotateExternalIdContext,
): Promise<RotateExternalIdResponse> {
  // 1. row 存在確認 (Get で取り出して PATCH 用に使う)。
  const existing = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: PK(ctx.tenantId), SK: SK(ctx.awsAccountId) },
    }),
  );
  if (!existing.Item) throw new CompetitorAccountNotFoundError(ctx.awsAccountId);
  // Issue #868: verified=false な行に対する rotate は禁止 (= ownership 未確認の account に
  // 鍵を回す経路で attacker spoof が成立しないように、 verify を必須前提にする)。
  if (existing.Item.verified !== true) {
    throw new CompetitorAccountNotVerifiedError(ctx.awsAccountId);
  }

  // 2. 現 ExternalId 存在確認 (= 鍵が完全消失している tenant に対する rotate は誤操作のサイン)。
  const currentExternalId = await getExternalId(
    { ssm: shared.ssm as SSMClient, env: shared.env },
    ctx.tenantId,
  );
  if (!currentExternalId) throw new ExternalIdMissingForRotationError(ctx.tenantId);

  // 3. SSM Overwrite で新値を Put (= version 履歴は SSM 側に蓄積)。
  const { externalId: newExternalId } = await rotateExternalId(
    { ssm: shared.ssm as SSMClient, env: shared.env },
    ctx.tenantId,
  );

  // 4. DDB の rotatedAt / updatedAt を Update。row 不在は (1) で弾いているはずだが、TOCTOU
  //    に備えて ConditionExpression で再確認する。
  const rotatedAt = new Date(ctx.nowMs).toISOString();
  try {
    const out = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: PK(ctx.tenantId), SK: SK(ctx.awsAccountId) },
        UpdateExpression: "SET rotatedAt = :r, updatedAt = :u",
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
        ExpressionAttributeValues: { ":r": rotatedAt, ":u": rotatedAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    const summary = toSummary((out.Attributes ?? {}) as Partial<CompetitorAccountItem>);
    return {
      ...summary,
      rotatedAt,
      externalId: newExternalId,
      tenkaCloudAccountId: shared.tenkaCloudAccountId,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      throw new CompetitorAccountNotFoundError(ctx.awsAccountId);
    }
    throw err;
  }
}
