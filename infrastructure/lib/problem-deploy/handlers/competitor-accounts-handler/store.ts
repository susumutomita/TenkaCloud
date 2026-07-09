import type { SSMClient } from "@aws-sdk/client-ssm";
import { controlDataRuntime } from "../../control-data/runtime-repositories.js";
import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
} from "../../control-data/types.js";
import { deleteExternalId, ensureExternalId } from "../shared/external-id-store.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import type {
  CompetitorAccountSummary,
  CreateCompetitorAccountRequest,
  CreateCompetitorAccountResponse,
} from "./types.js";

/**
 * [Issue #2442 / Phase C2] Resolves the CompetitorAccounts repository seam
 * for the injected shared resources. The raw DDB access this module
 * previously performed inline (PutCommand / QueryCommand / GetCommand /
 * UpdateCommand / DeleteCommand) now lives behind
 * {@link controlDataRuntime.resolveCompetitorAccountsRepository}
 * ({@link DynamoDbCompetitorAccountsRepository} / {@link SqlCompetitorAccountsRepository}).
 */
function resolveRepository(
  shared: CompetitorAccountsSharedResources,
): Promise<CompetitorAccountsRepository> {
  return controlDataRuntime.resolveCompetitorAccountsRepository({
    ddb: shared.ddb,
    competitorAccountsTableName: shared.tableName,
  });
}

const toSummary = (record: Partial<CompetitorAccountRecord>): CompetitorAccountSummary => ({
  awsAccountId: String(record.awsAccountId ?? ""),
  region: String(record.region ?? "ap-northeast-1"),
  competitorRoleName: String(record.competitorRoleName ?? ""),
  alias: typeof record.alias === "string" ? record.alias : undefined,
  verified: record.verified === true,
  verifiedAt: typeof record.verifiedAt === "string" ? record.verifiedAt : undefined,
  createdAt: String(record.createdAt ?? ""),
  updatedAt: String(record.updatedAt ?? ""),
  rotatedAt: typeof record.rotatedAt === "string" ? record.rotatedAt : undefined,
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
 * 2. repository seam 経由で行を作成 — 同 (tenantId, awsAccountId) が既存なら `conflict`
 *    outcome (DynamoDB `attribute_not_exists` 不成立 / SQL PRIMARY KEY 違反) を
 *    `DuplicateCompetitorAccountError` に変換する。
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
  const record: CompetitorAccountRecord = {
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

  const repository = await resolveRepository(shared);
  const outcome = await repository.createAccount(record);
  if (outcome.outcome === "conflict") {
    throw new DuplicateCompetitorAccountError(req.awsAccountId);
  }

  return {
    ...toSummary(record),
    externalId,
    tenkaCloudAccountId: shared.tenkaCloudAccountId,
  };
}

/** tenant 内の全 competitor account を一覧する (= verified / unverified 両方)。 */
export async function listCompetitorAccounts(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
): Promise<readonly CompetitorAccountSummary[]> {
  const repository = await resolveRepository(shared);
  const records = await repository.listAccounts(tenantId);
  return records.map(toSummary);
}

export async function getCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
  awsAccountId: string,
): Promise<CompetitorAccountSummary | undefined> {
  const repository = await resolveRepository(shared);
  const record = await repository.getAccount(tenantId, awsAccountId);
  return record ? toSummary(record) : undefined;
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
  const repository = await resolveRepository(shared);
  const outcome = await repository.markVerified(ctx.tenantId, ctx.awsAccountId, ctx.verifiedAt);
  if (outcome.outcome === "not_found") {
    throw new CompetitorAccountNotFoundError(ctx.awsAccountId);
  }
  return toSummary(outcome.record ?? {});
}

/**
 * row を削除。**同 tenant の最後の row** だった場合は SSM の ExternalId も削除する (= clean rotation)。
 *
 * repository seam の `deleteAccount` outcome で行不在を atomic 検出 (= TOCTOU 回避、1
 * round-trip 削減)。残行確認は `hasRemainingAccounts` (DynamoDB `Select: COUNT` +
 * `Limit: 1`) で wire payload を最小化する。
 */
export async function deleteCompetitorAccount(
  shared: CompetitorAccountsSharedResources,
  tenantId: string,
  awsAccountId: string,
): Promise<void> {
  const repository = await resolveRepository(shared);
  const outcome = await repository.deleteAccount(tenantId, awsAccountId);
  if (outcome.outcome === "not_found") {
    throw new CompetitorAccountNotFoundError(awsAccountId);
  }

  // 残行ゼロなら SSM の ExternalId も掃除する (= 鍵漏洩リスク減)。
  const hasRemaining = await repository.hasRemainingAccounts(tenantId);
  if (!hasRemaining) {
    await deleteExternalId({ ssm: shared.ssm as SSMClient, env: shared.env }, tenantId);
  }
}
