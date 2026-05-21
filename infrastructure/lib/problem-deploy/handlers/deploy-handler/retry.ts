import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ULID_RE as JOB_ID_RE } from "../shared/constants.js";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import { logDeployTrace } from "../shared/trace-log.js";
import type { DeploySharedResources } from "./deploy.js";
import type { DeploymentItem } from "./types.js";

/**
 * Issue #911 (#895 Phase 2.D): bulk batch で FAILED になった item の jobId 配列を受け取り、
 * **FAILED 行のみ** を PENDING に戻して `DeployCreateRequested` event を再 publish する
 * retry API。 成功済 / IN_PROGRESS / その他 status の row は touch しない (= idempotent)。
 *
 * 重要な性質:
 *  - cross-tenant safety: caller (TenantAdmin) の tenantId と一致しない row は skip (= 別 tenant
 *    の deploy を巻き込み再起動しない)。 row 自体が無いときも skip
 *  - idempotent: 成功済 (COMPLETE) は no-op、 in-progress (IN_PROGRESS / PENDING) も no-op
 *    (= 進行中を勝手に巻き戻さない、 operator は明示的に DELETE してから retry する設計)
 *  - 部分成功: 配列の一部だけ FAILED でも処理続行し、 各 jobId ごとの結果を返す
 *
 * 入力: \`{ failedJobIds: ["01HX...", "01HX..."] }\`
 * 出力: \`{ items: [{ jobId, action: \"requeued\" | \"skipped\", reason? }, ...] }\`
 *   - action=\"requeued\": FAILED → PENDING に戻し、 event 再 publish 成功
 *   - action=\"skipped\": cross-tenant / not_found / not_failed / publish_failed のいずれか
 */

export interface RetryDeploymentsRequest {
  readonly failedJobIds: readonly string[];
}

export type RetryAction = "requeued" | "skipped";

export interface RetryDeploymentResult {
  readonly jobId: string;
  readonly action: RetryAction;
  /** action=\"skipped\" のとき理由を返す (cross_tenant / not_found / not_failed / publish_failed)。 */
  readonly reason?: string;
}

export interface RetryDeploymentsResponse {
  readonly items: readonly RetryDeploymentResult[];
}

const MAX_RETRY_BATCH_SIZE = 750;

export class InvalidRetryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRetryRequestError";
  }
}

export function validateRetryRequest(raw: unknown): RetryDeploymentsRequest {
  if (!raw || typeof raw !== "object") {
    throw new InvalidRetryRequestError("body must be a JSON object");
  }
  const failedJobIds = (raw as { failedJobIds?: unknown }).failedJobIds;
  if (!Array.isArray(failedJobIds)) {
    throw new InvalidRetryRequestError("failedJobIds must be an array of jobId strings");
  }
  if (failedJobIds.length === 0) {
    throw new InvalidRetryRequestError("failedJobIds must not be empty");
  }
  if (failedJobIds.length > MAX_RETRY_BATCH_SIZE) {
    throw new InvalidRetryRequestError(
      `failedJobIds must not exceed ${MAX_RETRY_BATCH_SIZE} entries (got ${failedJobIds.length})`,
    );
  }
  for (const jobId of failedJobIds) {
    if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
      throw new InvalidRetryRequestError(
        `failedJobIds must all be ULID strings (got ${JSON.stringify(jobId)})`,
      );
    }
  }
  // dedupe しないと同じ jobId を 2 回触りに行って 2 回目が ConditionExpression で fail する
  // (= 1 回目で PENDING に戻した直後の row は FAILED でなくなる)。 caller が混入させた重複を
  // 無害化する。
  const deduped = Array.from(new Set(failedJobIds as readonly string[]));
  return { failedJobIds: deduped };
}

/**
 * 1 jobId を retry する。 cross-tenant / status / publish 失敗のいずれでも throw せず、
 * caller には `RetryDeploymentResult` を返す (= 部分成功を表現するため batch loop は throw
 * しない設計)。
 */
async function retryOne(
  shared: DeploySharedResources,
  callerTenantId: string,
  jobId: string,
  now: () => number,
): Promise<RetryDeploymentResult> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = out.Item as Partial<DeploymentItem> | undefined;
  if (!item?.jobId) {
    return { jobId, action: "skipped", reason: "not_found" };
  }
  if (item.tenantId !== callerTenantId) {
    // 別 tenant の row を見せない (= 404 相当扱い、 reason は cross_tenant としつつ caller
    // には not_found との区別を与えない方が安全)。
    return { jobId, action: "skipped", reason: "not_found" };
  }
  if (item.status !== "FAILED") {
    return { jobId, action: "skipped", reason: "not_failed" };
  }

  // FAILED → PENDING に巻き戻す。 ConditionExpression で並走時の race (= 既に他経路で再 trigger
  // されている / 同じ retry 配列内の重複) を防ぐ。
  const updated = await transitionRetryToPending(shared, callerTenantId, jobId, now);
  if (!updated) return { jobId, action: "skipped", reason: "not_failed" };

  // 元 deploy 時に書いた item + shared.problemsCatalog から DeployCreateRequestedDetail
  // を再構築する。 namePrefix / region / awsAccountId / competitor metadata は item に持って
  // いる。 problemDir は shared.problemsCatalog (= module-load 時の static catalog) で
  // problemId から解決。
  const detail = buildRetryDetail(shared, item, callerTenantId, jobId);
  if (!detail) return { jobId, action: "skipped", reason: "unknown_problem" };
  // 既知 limitation: challengePayloadUrl (= private 問題用 presigned URL) は retry で再生成
  // しない。 期限切れ URL を渡すと CodeBuild 内で 403 になり再度 FAILED に倒れる。 private
  // 問題の retry は当面 manual (= operator が新 deploy として再投入) で運用、 Phase 2.D
  // follow-up で presigned URL regen を入れる予定。
  const published = await publishRetryEvent(shared, callerTenantId, jobId, detail, now);
  if (!published) return { jobId, action: "skipped", reason: "publish_failed" };

  logDeployTrace("deploy.retry.requeued", {
    jobId,
    correlationId: jobId,
    tenantId: callerTenantId,
    problemId: detail.problemId,
  });
  return { jobId, action: "requeued" };
}

async function transitionRetryToPending(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  now: () => number,
): Promise<boolean> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
        UpdateExpression: "SET #s = :pending, updatedAt = :updatedAt REMOVE failureReason",
        ConditionExpression: "#s = :failed AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pending": "PENDING",
          ":failed": "FAILED",
          ":updatedAt": new Date(now()).toISOString(),
          ":tenantId": tenantId,
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

function buildRetryDetail(
  shared: DeploySharedResources,
  item: Partial<DeploymentItem>,
  tenantId: string,
  jobId: string,
): DeployCreateRequestedDetail | undefined {
  const problemId = String(item.problemId ?? "");
  const problemDir = shared.problemsCatalog[problemId];
  if (!problemDir) return undefined;
  return {
    jobId,
    correlationId: jobId,
    tenantId,
    problemId,
    problemDir,
    teamSlug: String(item.teamName ?? ""),
    namePrefix: String(item.namePrefix ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    ...(item.competitorRoleArn ? { competitorRoleArn: item.competitorRoleArn } : {}),
    ...(item.externalIdParameterName
      ? { externalIdParameterName: item.externalIdParameterName }
      : {}),
  };
}

async function publishRetryEvent(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  detail: DeployCreateRequestedDetail,
  now: () => number,
): Promise<boolean> {
  try {
    await publishProblemEvent({
      client: shared.events,
      busName: shared.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_CREATE_REQUESTED,
      jobId,
      detail,
    });
    return true;
  } catch (err) {
    await compensateRetryPublishFailure(shared, tenantId, jobId, now);
    logDeployTrace("deploy.retry.publish_failed", {
      jobId,
      correlationId: jobId,
      tenantId,
      message: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

async function compensateRetryPublishFailure(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  now: () => number,
): Promise<void> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "#s = :pending AND tenantId = :tenantId",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":pending": "PENDING",
          ":updatedAt": new Date(now()).toISOString(),
          ":reason": "Failed to re-publish DeployCreateRequested event during retry",
          ":tenantId": tenantId,
        },
      }),
    );
  } catch {
    // ignore: best-effort rollback
  }
}

/**
 * 配列内の各 jobId に対して `retryOne` を逐次実行する (= caller の tenantId scope に閉じる)。
 * 並列化は不要 (= 750 件でも 1 件あたり数 ms、 操作頻度低い)。
 */
export async function retryDeployments(
  shared: DeploySharedResources,
  callerTenantId: string,
  request: RetryDeploymentsRequest,
  now: () => number = () => Date.now(),
): Promise<RetryDeploymentsResponse> {
  const results: RetryDeploymentResult[] = [];
  for (const jobId of request.failedJobIds) {
    results.push(await retryOne(shared, callerTenantId, jobId, now));
  }
  return { items: results };
}
