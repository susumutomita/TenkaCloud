import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  EVENT_SOURCE,
  putEventsBatched,
} from "../shared/events.js";
import {
  type EventSharedResources,
  queryDeploymentsByEvent,
  resolveEventsRepository,
} from "./shared.js";

export interface BulkTeardownResult {
  readonly eventId: string;
  readonly enqueued: number;
  readonly skipped: number;
  /**
   * #1797: status=DELETING には倒せたが DeployDeleteRequested の publish に失敗した件数。
   * EventBridge PutEvents は HTTP 200 でも `FailedEntryCount > 0` で個別 entry が落ちうるため、
   * 失敗分は DELETING → FAILED に巻き戻して (= retry 可能にして) この数に計上する。
   * 0 でない場合、 operator は再度 DELETE を叩けば FAILED 行が再 teardown される。
   */
  readonly failed: number;
}

export type BulkTeardownOutcome =
  | { kind: "ok"; result: BulkTeardownResult }
  | { kind: "not_found" };

type UpdateOutcome = { entry: PutEventsRequestEntry; jobId: string } | { skip: true };

/**
 * `DELETE /events/{eventId}` の実体。
 *
 * 1. Event 行を Get で確認 (= tenantId mismatch / 不在は not_found)
 * 2. Deployments を GSI1 で query → eventId フィルタ (Phase 3+ で eventId 専用 GSI 化を検討)
 * 3. 各行を `Promise.all` 並列で `status=DELETING` に conditional update
 * 4. update 成功分の DeployDeleteRequested を chunk 並列 publish
 *
 * 既に DELETING / DELETED な行 / 並行更新 race / 必須フィールド欠損は skipped に計上
 * (= 操作者の再実行に対して idempotent)。
 *
 * 失敗 semantics (#1797): EventBridge PutEvents は HTTP 200 でも `FailedEntryCount > 0` で
 * 個別 entry が落ちうる / chunk 全体が reject しうる。 publish に失敗した行は
 * DELETING → FAILED に巻き戻して `result.failed` に計上する (= 単一 delete の
 * `compensateFailedTeardownPublish` と対称)。 FAILED 行は再 DELETE で retry されるため、
 * DELETING のまま skip され永久に orphan 化する旧挙動を解消する。
 */
export async function bulkTeardownEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<BulkTeardownOutcome> {
  // getEvent は tenant 不一致 / event 不在をどちらも undefined に畳む
  // (= 従来の `!event || event.tenantId !== tenantId` を repository 内へ移設)。 events-only seam
  // を使う (scheduled teardown 経路は Teams table を配線しないため)。
  const event = await resolveEventsRepository(shared).getEvent(tenantId, eventId);
  if (!event) return { kind: "not_found" };

  const targets = await queryDeploymentsByEvent(shared, tenantId, eventId);
  if (targets.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0, failed: 0 } };
  }

  const updatedAt = new Date(nowMs).toISOString();

  // 各 deployment の status=DELETING update を Promise.all で並列発火 (750 件 × 50ms
  // = 37.5s の逐次は Lambda timeout に到達する)。各 update は独立で互いに依存しない。
  const outcomes = await Promise.all(
    targets.map((item) => prepareBulkTeardownEntry(shared, tenantId, updatedAt, item)),
  );

  const pending: Array<{ entry: PutEventsRequestEntry; jobId: string }> = [];
  let skipped = 0;
  for (const o of outcomes) {
    if ("skip" in o) skipped++;
    else pending.push(o);
  }

  // #1797 / #2210: PutEvents は HTTP 200 でも `FailedEntryCount > 0` で個別 entry が落ちうる
  // (throttling 等)。 旧コードは送りっぱなしで FailedEntryCount を見ず、 落ちた teardown event を
  // silent に握り潰して stack を orphan 化させていた (= 他の PutEvents 経路は全て検査済なのに
  // ここだけ未検査だった)。 chunk 分割 + FailedEntryCount 検査は shared helper に委譲、 ここは
  // 「失敗した jobId を集める」 という call site 固有の意味付けだけを持つ。
  const publish = putEventsBatched(
    shared.events,
    pending.map((p) => ({ item: p.jobId, entry: p.entry })),
  );

  // #557: Event status を TEARDOWN に倒す。bulk-deploy が DRAFT → DEPLOYING にする
  // 対称で、こちらは「終端化中」 marker。 [#2437 Phase A2] 条件付き書き込みは repository seam
  // の `markTeardown(tenantId, eventId, at)` に移設 (ARCHIVED は踏み越えない条件も seam 内)。
  // conflict (= 既に ARCHIVED / 行不在) は触らないだけで成功扱い (handler は getEvent で確認済)。
  // PutEvents と並列実行 (互いに依存なし)。
  const updateStatus = resolveEventsRepository(shared).markTeardown(tenantId, eventId, updatedAt);
  const [publishResults] = await Promise.all([publish, updateStatus]);
  const failedJobIds = publishResults.filter((r) => !r.success).map((r) => r.item);

  // #1797: publish に失敗した行は DELETING のまま放置すると、 次回 DELETE 呼び出しで
  // 「既に DELETING」 として skip され永久に teardown されない (= silent orphan)。 単一 delete
  // (delete.ts の compensateFailedTeardownPublish) と対称に DELETING → FAILED へ巻き戻し、
  // operator の再 DELETE で retry できるようにする。
  await Promise.all(
    failedJobIds.map((jobId) => compensateBulkTeardownPublish(shared, tenantId, jobId, updatedAt)),
  );

  return {
    kind: "ok",
    result: {
      eventId,
      enqueued: pending.length - failedJobIds.length,
      skipped,
      failed: failedJobIds.length,
    },
  };
}

/**
 * #1797: publish に失敗した teardown 行を DELETING → FAILED に巻き戻す (= retry 可能化)。
 * ConditionExpression で DELETING の行だけを対象にし、 既に他経路で FAILED/DELETED になった行は
 * 触らない (CCF は無視 = best-effort、 元の publish 失敗が主シグナル)。
 */
async function compensateBulkTeardownPublish(
  shared: EventSharedResources,
  tenantId: string,
  jobId: string,
  updatedAt: string,
): Promise<void> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.deploymentsTableName,
        Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
        UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
        ConditionExpression: "tenantId = :tenantId AND #s = :deleting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":deleting": "DELETING",
          ":updatedAt": updatedAt,
          ":reason": "Failed to publish DeployDeleteRequested event (bulk teardown)",
          ":tenantId": tenantId,
        },
      }),
    );
  } catch {
    // best-effort: CCF (行が既に DELETING でない) も他の DDB error も握る。 巻き戻し失敗が
    // 元の publish 失敗 (= result.failed に計上済) を覆い隠さないようにする。 delete.ts の
    // compensateFailedTeardownPublish と同じ best-effort セマンティクス。
  }
}

async function prepareBulkTeardownEntry(
  shared: EventSharedResources,
  tenantId: string,
  updatedAt: string,
  item: Partial<DeploymentItem>,
): Promise<UpdateOutcome> {
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (status === "DELETING" || status === "DELETED") return { skip: true };
  const target = getBulkTeardownTarget(item);
  if (!target) return { skip: true };
  const transitioned = await transitionBulkTargetToDeleting(
    shared,
    tenantId,
    updatedAt,
    target.jobId,
  );
  if (!transitioned) return { skip: true };
  const detail = await buildBulkTeardownDetail(shared, tenantId, item, target);
  return {
    jobId: target.jobId,
    entry: {
      EventBusName: shared.eventBusName,
      Source: EVENT_SOURCE,
      DetailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
      Detail: JSON.stringify(detail),
      Resources: [`tenkacloud:deployment:${target.jobId}`],
    },
  };
}

function getBulkTeardownTarget(item: Partial<DeploymentItem>):
  | {
      readonly jobId: string;
      readonly region: string;
      readonly awsAccountId: string;
      readonly stackName: string;
    }
  | undefined {
  const target = {
    jobId: String(item.jobId ?? ""),
    region: String(item.region ?? ""),
    awsAccountId: String(item.awsAccountId ?? ""),
    // #1810: FAILED deployment は stack ARN 記録前に終わると stackId="" (空文字) になる。
    // `??` は空文字を fallback しないので `||` を使い namePrefix に倒す (空 stackName で
    // skip され失敗 stack が orphan 化するのを防ぐ)。
    stackName: String(item.stackId || item.namePrefix || ""),
  };
  return Object.values(target).every(Boolean) ? target : undefined;
}

async function transitionBulkTargetToDeleting(
  shared: EventSharedResources,
  tenantId: string,
  updatedAt: string,
  jobId: string,
): Promise<boolean> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.deploymentsTableName,
        Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
        UpdateExpression: "SET #s = :deleting, updatedAt = :updatedAt",
        // Issue #2019: include APPROVAL_PENDING (:ap) so a held deploy is not
        // orphaned by bulk teardown (it has no live stack; DeleteStack is a no-op).
        ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :ap, :i, :c, :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":updatedAt": updatedAt,
          ":tenantId": tenantId,
          ":p": "PENDING",
          ":ap": "APPROVAL_PENDING",
          ":i": "IN_PROGRESS",
          ":c": "COMPLETE",
          ":f": "FAILED",
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function buildBulkTeardownDetail(
  shared: EventSharedResources,
  tenantId: string,
  item: Partial<DeploymentItem>,
  target: NonNullable<ReturnType<typeof getBulkTeardownTarget>>,
): Promise<DeployDeleteRequestedDetail> {
  const verified = hasAssumeRoleMetadata(item)
    ? undefined
    : await resolveVerifiedCompetitorAccount(
        {
          ddb: shared.ddb,
          competitorAccountsTableName: shared.competitorAccountsTableName,
          env: shared.env,
        },
        tenantId,
        target.awsAccountId,
      );
  return {
    ...target,
    correlationId: target.jobId,
    tenantId,
    competitorRoleArn: hasAssumeRoleMetadata(item)
      ? item.competitorRoleArn
      : verified?.competitorRoleArn,
    externalIdParameterName: hasAssumeRoleMetadata(item)
      ? item.externalIdParameterName
      : verified?.externalIdParameterName,
  };
}

function hasAssumeRoleMetadata(item: Partial<DeploymentItem>): boolean {
  return (
    typeof item.competitorRoleArn === "string" &&
    item.competitorRoleArn.length > 0 &&
    typeof item.externalIdParameterName === "string" &&
    item.externalIdParameterName.length > 0
  );
}
