import type { SSMClient } from "@aws-sdk/client-ssm";

import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
} from "../../control-data/types.js";
import { deleteExternalId, ensureExternalId } from "../shared/external-id-store.js";
import type { CompetitorAccountsSharedResources } from "./shared.js";
import type {
  BulkCompetitorAccountEntry,
  BulkCompetitorAccountResult,
  BulkCreateCompetitorAccountsRequest,
  BulkCreateCompetitorAccountsResponse,
  CompetitorAccountSummary,
  CreateCompetitorAccountRequest,
  CreateCompetitorAccountResponse,
} from "./types.js";

/**
 * [Issue #2442 / Phase C2] Resolves the CompetitorAccounts repository seam
 * for the injected shared resources. The raw DDB access this module
 * previously performed inline (PutCommand / QueryCommand / GetCommand /
 * UpdateCommand / DeleteCommand) now lives behind
 * the injected runtime's `resolveCompetitorAccountsRepository`
 * ({@link DynamoDbCompetitorAccountsRepository} / {@link SqlCompetitorAccountsRepository}).
 */
function resolveRepository(
  shared: CompetitorAccountsSharedResources,
): Promise<CompetitorAccountsRepository> {
  return shared.runtime.resolveCompetitorAccountsRepository({
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

/**
 * 送る前に弾ける行を判定する。 repository へ行かせないのは、 「JSON の中に同じ行が
 * 2 回ある」 「Role 名がどこにも無い」 が書き込みの失敗ではなく入力の誤りだから。
 */
function rejectBulkEntry(
  entry: BulkCompetitorAccountEntry,
  req: BulkCreateCompetitorAccountsRequest,
  seen: ReadonlySet<string>,
): BulkCompetitorAccountResult | undefined {
  const awsAccountId = entry.awsAccountId;
  if (seen.has(awsAccountId)) {
    return {
      outcome: "invalid",
      awsAccountId,
      message: "duplicate entry within this request",
    };
  }
  if (!(entry.competitorRoleName ?? req.defaults?.competitorRoleName)) {
    // 単体 create が zod default を持たないのと同じ理由 (= 暗黙の名前衝突を作らない)。
    return {
      outcome: "invalid",
      awsAccountId,
      message: "competitorRoleName is required on the entry or in defaults",
    };
  }
  return undefined;
}

interface BulkEntryWriteContext {
  readonly entry: BulkCompetitorAccountEntry;
  readonly defaults: BulkCreateCompetitorAccountsRequest["defaults"];
  readonly tenantId: string;
  readonly createdBy: string;
  readonly nowIso: string;
}

/** 1 行を書く。 書き込みの失敗はその行の結果にして、 呼び出し側の loop は止めない。 */
async function writeBulkEntry(
  repository: CompetitorAccountsRepository,
  ctx: BulkEntryWriteContext,
): Promise<BulkCompetitorAccountResult> {
  const { entry, defaults } = ctx;
  const awsAccountId = entry.awsAccountId;
  const record: CompetitorAccountRecord = {
    tenantId: ctx.tenantId,
    awsAccountId,
    region: entry.region ?? defaults?.region ?? "ap-northeast-1",
    // rejectBulkEntry が先に弾いているのでここでは必ず値がある。
    competitorRoleName: (entry.competitorRoleName ?? defaults?.competitorRoleName) as string,
    ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
    verified: false,
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    createdBy: ctx.createdBy,
  };

  try {
    const outcome = await repository.createAccount(record);
    if (outcome.outcome === "conflict") {
      return {
        outcome: "duplicate",
        awsAccountId,
        message: "already registered for this tenant",
      };
    }
    return { outcome: "created", awsAccountId };
  } catch (err) {
    // 1 行の write 失敗で残りを捨てない。 理由は行に載せ、 全体は 200 で返す
    // (= どの行が入ってどの行が入らなかったかを operator が読める)。
    const message = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    console.error("[competitor-accounts] bulk row failed", { awsAccountId, message });
    return { outcome: "failed", awsAccountId, message };
  }
}

/**
 * 複数 account の一括登録 (Issue: Organizations 規模の登録が 1 件ずつで大変というフィードバック)。
 *
 * 単体 create との違いは 2 点で、どちらも「多数行」という前提から来ている。
 *
 * 1. **ExternalId を request ごとに 1 度だけ確保する。** 単体 create は行ごとに
 *    {@link ensureExternalId} を呼ぶが、 tenant 初回の一括登録でこれを行ごとに並列で
 *    呼ぶと `PutParameter(Overwrite: false)` が互いに衝突する。 ここでは先に 1 度だけ
 *    確保し、 全行がその値を共有する (ExternalId は元々 tenant 単位なので意味は同じ)。
 * 2. **1 行の失敗で全体を落とさない。** 40 行中 1 行が登録済みだからといって残り 39 行を
 *    捨てるのは運用上まず正しくない。 行ごとに outcome を返し、 caller (route) が
 *    それぞれ audit を書く。
 *
 * 行は**逐次**処理する。 DDB の書き込みを同時に多数投げると、 容量を絞った table では
 * throttle して「一部だけ入った」状態になりうる。 100 行上限 (schema 側) なら逐次でも
 * Lambda の実行時間には収まる。
 */
export async function bulkCreateCompetitorAccounts(
  shared: CompetitorAccountsSharedResources,
  ctx: CreateCompetitorAccountContext,
  req: BulkCreateCompetitorAccountsRequest,
  onCreated?: (awsAccountId: string) => void,
  onRejected?: (awsAccountId: string, outcome: BulkCompetitorAccountResult["outcome"]) => void,
): Promise<BulkCreateCompetitorAccountsResponse> {
  const { externalId } = await ensureExternalId(
    { ssm: shared.ssm as SSMClient, env: shared.env },
    ctx.tenantId,
  );

  const nowIso = new Date(ctx.nowMs).toISOString();
  const repository = await resolveRepository(shared);
  const results: BulkCompetitorAccountResult[] = [];
  const seen = new Set<string>();

  for (const entry of req.accounts) {
    const awsAccountId = entry.awsAccountId;
    const rejection = rejectBulkEntry(entry, req, seen);
    if (rejection) {
      results.push(rejection);
      onRejected?.(awsAccountId, rejection.outcome);
      continue;
    }
    seen.add(awsAccountId);

    const result = await writeBulkEntry(repository, {
      entry,
      defaults: req.defaults,
      tenantId: ctx.tenantId,
      createdBy: ctx.createdBy,
      nowIso,
    });
    results.push(result);
    if (result.outcome === "created") onCreated?.(awsAccountId);
    else onRejected?.(awsAccountId, result.outcome);
  }

  const count = (outcome: BulkCompetitorAccountResult["outcome"]): number =>
    results.filter((result) => result.outcome === outcome).length;
  const created = count("created");

  return {
    results,
    created,
    duplicate: count("duplicate"),
    invalid: count("invalid"),
    failed: count("failed"),
    // 1 件も作れていないなら配る bootstrap が無いので、 secret を載せない。
    ...(created > 0 ? { externalId } : {}),
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
