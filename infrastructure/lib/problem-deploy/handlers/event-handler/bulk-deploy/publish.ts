import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { ulid } from "ulid";
import {
  type DeployCreateRequestedDetail,
  EVENT_DETAIL_TYPE_BULK_DEPLOY_CREATE_REQUESTED,
  EVENT_SOURCE,
  putEventsBatched,
} from "../../shared/events.js";
import { logDeployTrace } from "../../shared/trace-log.js";
import type { EventSharedResources } from "../shared.js";
import { markBulkEventDeploying } from "./persistence.js";
import type { PlanEntry, PublishFailure } from "./types.js";

/**
 * Event status の DEPLOYING 遷移と、 EventBridge への publish を並列実行する。
 * - feature flag (`useBulkDistributedMap` + `bulkDeployPayloadBucket` あり) なら
 *   Distributed Map 経路: S3 PutObject (= deployment 配列) + 1 BulkDeployCreateRequested publish
 * - 旧経路: `putEventsBatched` (shared/events.js) が chunk 分割して直接 DeployCreateRequested を
 *   fan-out publish
 *
 * 戻り値は publish 失敗一覧。 caller が markPublishFailuresFailed で deployment を FAILED 化する。
 */
export async function publishBulkDeployPlan(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdAt: string,
  plan: readonly PlanEntry[],
): Promise<PublishFailure[]> {
  const publish = Promise.all(publishBulkPlanEntries(shared, tenantId, eventId, plan));
  const [, failures] = await Promise.all([
    markBulkEventDeploying(shared, tenantId, eventId, createdAt),
    publish,
  ]);
  return failures.flat();
}

function publishBulkPlanEntries(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  plan: readonly PlanEntry[],
): Promise<PublishFailure[]>[] {
  if (shared.useBulkDistributedMap && shared.bulkDeployPayloadBucket.length > 0) {
    return [
      publishViaDistributedMap(shared, {
        batchId: ulid(),
        tenantId,
        eventId,
        details: plan.map(
          (entry) => JSON.parse(entry.entry.Detail ?? "{}") as DeployCreateRequestedDetail,
        ),
      }),
    ];
  }
  return [publishPlan(shared, plan)];
}

async function publishPlan(
  shared: EventSharedResources,
  plan: readonly PlanEntry[],
): Promise<PublishFailure[]> {
  const results = await putEventsBatched(
    shared.events,
    plan.map((p) => ({ item: p, entry: p.entry })),
  );
  return results
    .filter((r) => !r.success)
    .map((r) => ({
      jobId: r.item.item.jobId,
      reason: r.errorCode
        ? `${r.errorCode}: ${r.errorMessage ?? "unknown error"}`
        : (r.errorMessage ?? "unknown error"),
    }));
}

/**
 * Issue #910 (#895 Phase 2.C.2.b): Distributed Map 経路。 deployment 配列を S3 に PutObject
 * (= 1 call で payload を整理)、 続いて 1 `BulkDeployCreateRequested` event を publish。
 * Step Functions State Machine 側で `S3JsonItemReader` が読んで Distributed Map で N×M
 * child execution を並列起動する (= PR #921 で構築済の foundation)。
 *
 * 失敗モード:
 *   - S3 PutObject 失敗 → 全 plan を FAILED に倒す (= 旧 path の "1 event publish 失敗時
 *     全件 FAILED" と同セマンティクス)
 *   - PutEvents 失敗 → 同上
 *   - State Machine 内 child 失敗 → 個別 deployment は child SM 内で FAILED に倒れる (=
 *     既存 DeployCreateStateMachine の挙動)。 親 Map は ToleratedFailure 未設定で全 item
 *     を最後まで試す
 */
async function publishViaDistributedMap(
  shared: EventSharedResources,
  args: {
    readonly batchId: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly details: readonly DeployCreateRequestedDetail[];
  },
): Promise<PublishFailure[]> {
  const { batchId, tenantId, eventId, details } = args;
  const s3Key = `batches/${batchId}/deployments.json`;
  // S3 PutObject: payload = deployment 配列。 Distributed Map の S3JsonItemReader が
  // この shape (= top-level array) を要求する。 Content-Type は明示しないと Step Functions
  // 側で text/plain と誤認することがあるので application/json を強制。
  try {
    await shared.s3.send(
      new PutObjectCommand({
        Bucket: shared.bulkDeployPayloadBucket,
        Key: s3Key,
        Body: JSON.stringify(details),
        ContentType: "application/json",
        // 短命 + バケット自体に lifecycle (7 日) が掛かっているので追加 expires は不要。
      }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return details.map((d) => ({
      jobId: d.jobId,
      reason: `S3 PutObject failed for bulk payload: ${reason}`,
    }));
  }

  // 1 BulkDeployCreateRequested event を publish。 EventBridge Rule (PR #922 で wire 済) が
  // BulkDeployCreateStateMachine を起動する。 親 1 execution = 1 batch、 child は item 数分。
  try {
    const out = await shared.events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: shared.eventBusName,
            Source: EVENT_SOURCE,
            DetailType: EVENT_DETAIL_TYPE_BULK_DEPLOY_CREATE_REQUESTED,
            Detail: JSON.stringify({
              batchId,
              tenantId,
              s3Bucket: shared.bulkDeployPayloadBucket,
              s3Key,
              itemCount: details.length,
            }),
            Resources: [`tenkacloud:bulk-deploy:${batchId}`, `tenkacloud:event:${eventId}`],
          },
        ],
      }),
    );
    if ((out.FailedEntryCount ?? 0) > 0) {
      const reason = out.Entries?.[0]?.ErrorMessage ?? "EventBridge PutEvents failed";
      return details.map((d) => ({
        jobId: d.jobId,
        reason: `BulkDeployCreateRequested publish failed: ${reason}`,
      }));
    }
    logDeployTrace("bulk-deploy.distributed_map.published", {
      correlationId: batchId,
      tenantId,
      eventId,
      itemCount: details.length,
      s3Bucket: shared.bulkDeployPayloadBucket,
      s3Key,
    });
    return [];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return details.map((d) => ({
      jobId: d.jobId,
      reason: `BulkDeployCreateRequested publish failed: ${reason}`,
    }));
  }
}
