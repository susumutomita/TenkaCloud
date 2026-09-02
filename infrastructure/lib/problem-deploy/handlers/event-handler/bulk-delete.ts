import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type {
  DeploymentsCoordinationPort,
  DeploymentsLifecyclePort,
} from "../../control-data/deployments-repository.js";
import { buildAdapterDependencies } from "../deploy-handler/adapter-dependencies.js";
import { slugify } from "../deploy-handler/naming.js";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import { resolveCoordinationArtifactStore } from "../shared/coordination-artifact-store.js";
import { deleteAllCoordinationRuns } from "../shared/coordination-run.js";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  EVENT_SOURCE,
  putEventsBatched,
} from "../shared/events.js";
import {
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  type ProblemRuntime,
  resolveItemRuntime,
  selectAdapter,
} from "../shared/runtime/index.js";
import { logDeployTrace } from "../shared/trace-log.js";
import {
  type EventSharedResources,
  queryDeploymentsByEvent,
  resolveDeploymentsRepository,
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

/**
 * [#2571] Bulk teardown per-row outcome. The AWS/CFn path (`entry` present)
 * publishes `DeployDeleteRequested` in a batch, same as before. The non-AWS
 * adapter path (gcp/azure/sakura) performs its `adapter.destroy` REST call
 * inline (`prepareBulkAdapterTeardown`) instead of producing a
 * `PutEventsRequestEntry` — `adapterEnqueued` / `adapterFailed` report the
 * outcome directly so the caller folds them into `enqueued` / `failed`
 * without a second (EventBridge) publish round for these rows.
 */
type UpdateOutcome =
  | { entry: PutEventsRequestEntry; jobId: string }
  /**
   * [Issue #3123] `deletedLike` separates the two very different reasons a row
   * is skipped. A row already `DELETING` / `DELETED` is finished — a retried
   * teardown sees every row that way, and that retry is exactly when the
   * coordination cleanup must run. Every other skip leaves a row that is still
   * `PENDING` / `COMPLETE` / `FAILED`, i.e. one a participant can still submit
   * through, so the shared namespace must not be deleted under it.
   */
  | { skip: true; deletedLike?: true }
  | { adapterEnqueued: string }
  | { adapterFailed: string };

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
  // events-only seam を 1 度だけ解決し getEvent / markTeardown で使い回す (= turso 選択時の
  // cold-start cache を 1 回に畳む)。 getEvent は tenant 不一致 / event 不在をどちらも undefined に
  // 畳む (= 従来の `!event || event.tenantId !== tenantId` を repository 内へ移設)。 events-only seam
  // を使う (scheduled teardown 経路は Teams table を配線しないため)。
  const events = await resolveEventsRepository(shared);
  const event = await events.getEvent(tenantId, eventId);
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
  // [#2571] Non-AWS adapter rows already ran their `adapter.destroy` call (+
  // compensation on failure) inside `prepareBulkTeardownEntry` — they never
  // produce a `PutEventsRequestEntry`, so they are tallied here directly
  // rather than riding the EventBridge publish batch below.
  let adapterEnqueued = 0;
  let adapterFailed = 0;
  // [Issue #3123] Skips that left a row still live, as opposed to a row that
  // was already gone. Only the first kind blocks the coordination cleanup.
  let activeSkipped = 0;
  for (const o of outcomes) {
    if ("skip" in o) {
      skipped++;
      if (!o.deletedLike) activeSkipped++;
    } else if ("adapterEnqueued" in o) adapterEnqueued++;
    else if ("adapterFailed" in o) adapterFailed++;
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
  const updateStatus = events.markTeardown(tenantId, eventId, updatedAt);
  const [publishResults] = await Promise.all([publish, updateStatus]);
  const failedJobIds = publishResults.filter((r) => !r.success).map((r) => r.item);

  // #1797: publish に失敗した行は DELETING のまま放置すると、 次回 DELETE 呼び出しで
  // 「既に DELETING」 として skip され永久に teardown されない (= silent orphan)。 単一 delete
  // (delete.ts の compensateFailedTeardownPublish) と対称に DELETING → FAILED へ巻き戻し、
  // operator の再 DELETE で retry できるようにする。
  await Promise.all(
    failedJobIds.map((jobId) => compensateBulkTeardownPublish(shared, tenantId, jobId, updatedAt)),
  );

  // [Issue #3123] Event cleanup owns the coordination namespaces this event
  // created. Deployment teardown alone cannot: coordination state is shared by
  // every team on a problem, so deleting it when ONE team's deployment goes
  // away would wipe a match the others are still playing. The event is the
  // first boundary at which no team is left.
  //
  // Only once every target is actually gone, though. Three things leave a
  // deployment live after this call, and all three still resolve a coordination
  // scope (`canSubmitCoordination` filters only deleted-like statuses):
  //
  //   - a failed publish, compensated `DELETING` -> `FAILED` for the operator
  //     to retry,
  //   - a failed adapter teardown, compensated the same way,
  //   - a skip that was not "already deleted" — a row with no usable teardown
  //     target, a lost `DELETING` transition, or an adapter row whose SSM
  //     wiring is absent.
  //
  // Deleting the shared namespace in any of those cases drops the match state
  // while the problem is still reachable, and the next op rebuilds it from
  // `initialState` before the retry even runs. The retry calls this same path —
  // and by then those rows read as deleted-like, so it does clean up. If no
  // retry ever comes, the row's `expiresAt` reaps it.
  const uncommitted = failedJobIds.length + adapterFailed + activeSkipped;
  if (uncommitted === 0) {
    await deleteEventCoordinationState(shared, tenantId, eventId, targets);
  } else {
    logDeployTrace("bulk-teardown.coordination.cleanup-deferred", {
      tenantId,
      eventId,
      failed: String(failedJobIds.length + adapterFailed),
      activeSkipped: String(activeSkipped),
    });
  }

  return {
    kind: "ok",
    result: {
      eventId,
      enqueued: pending.length - failedJobIds.length + adapterEnqueued,
      skipped,
      failed: failedJobIds.length + adapterFailed,
    },
  };
}

/**
 * [Issue #3123] Drops the coordination state of every problem this event
 * deployed.
 *
 * Deletes are issued for each distinct `problemId` among the event's
 * deployments, not only for problems that declare a coordination plugin: this
 * module has no `PROBLEM_COORDINATION` config (that env belongs to the
 * participant handler), and a delete against an absent row is a no-op on both
 * backends. Asking the config would couple event teardown to the participant
 * Lambda's wiring to save nothing.
 *
 * Best-effort by design — teardown already reported which stacks it enqueued,
 * and failing the whole call here would leave the operator unable to tell a
 * leaked CloudFormation stack (money, real resources) from a leaked state row
 * (bytes, and covered by the row's TTL). The failure is logged rather than
 * swallowed, and the row's `expiresAt` backstop still reaps it.
 */
async function deleteEventCoordinationState(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  targets: readonly Partial<DeploymentItem>[],
): Promise<void> {
  const problemIds = new Set(
    targets
      .map((item) => item.problemId)
      .filter((problemId): problemId is string => typeof problemId === "string" && !!problemId),
  );
  if (problemIds.size === 0) return;
  const ordered = [...problemIds];
  // `allSettled`, not `all`: one rejection must not strand the others. A Lambda
  // freezes its execution environment the moment the handler returns, so a
  // promise still in flight when `Promise.all` short-circuited would simply
  // never finish — a namespace whose delete had no error at all would leak.
  //
  // The repository is resolved inside each task rather than once outside, so
  // this has exactly one failure path. Resolving outside needed a second
  // try/catch for it, which no test could reach honestly: the resolver already
  // ran for `queryDeploymentsByEvent` above, the SQL executor is cached per
  // cold start, and the DynamoDB branch reads the same two fields of the same
  // `shared` object. A branch that cannot fail is not a safety net, it is
  // unreachable code that hides which namespace actually failed.
  const artifacts = resolveCoordinationArtifactStore();
  const settled = await Promise.allSettled(
    ordered.map(async (problemId) => {
      const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(shared);
      // [Issue #3153] Every run of the problem, not just the current one. The
      // event is going away, so its retained history goes with it — leaving it
      // would keep matches nothing names and nothing can reach.
      //
      // [Issue #3152] Each run's artifacts go with that run's state. The state
      // is what makes them reachable, so removing it first means a failure
      // afterwards leaves objects nothing can read, rather than a playable
      // board pointing at nothing.
      await deleteAllCoordinationRuns(
        { repository, artifacts },
        {
          tenantId,
          eventId,
          problemId,
        },
      );
    }),
  );
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") continue;
    const reason = outcome.reason;
    logDeployTrace("bulk-teardown.coordination.cleanup-failed", {
      tenantId,
      eventId,
      problemIds: ordered[index],
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  }
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
    // [Issue #2441 / Phase B2] `compensateBulkTeardown` folds the CCF into a
    // `conflict` outcome; the try/catch here still guards against any other
    // DDB error (best-effort, matches delete.ts's compensateFailedTeardownPublish).
    const repository: DeploymentsLifecyclePort = await resolveDeploymentsRepository(shared);
    await repository.compensateBulkTeardown(jobId, tenantId, updatedAt);
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
  if (status === "DELETING" || status === "DELETED") return { skip: true, deletedLike: true };

  // [#2571] Non-AWS runtime (sakura/azure/gcp) rows never carry a region /
  // awsAccountId CFn can act on (both persisted as "", #2571 plan-builder) —
  // `getBulkTeardownTarget` below would always fail them and silently `skip`,
  // which is the exact leak this fixes (cloud resources orphaned on event
  // teardown). Mirrors `delete.ts`'s `resolveItemRuntime` + `teardownViaAdapter`
  // branch.
  const runtime = resolveItemRuntime(item);
  if (runtime.provider !== EXECUTABLE_PROVIDER || runtime.engine !== EXECUTABLE_ENGINE) {
    return prepareBulkAdapterTeardown(shared, tenantId, updatedAt, item, runtime);
  }

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

/**
 * [#2571] Bulk teardown for a non-AWS single-provider row. Mirrors `delete.ts`'s
 * `teardownViaAdapter`: transitions DELETING, resolves the adapter for the
 * row's stored runtime, and calls `adapter.destroy` directly (no EventBridge /
 * CFn — the row never had a stack for CFn to delete).
 *
 * [#2571 review-fix] `buildAdapterDependencies` + `selectAdapter` now run
 * INSIDE the same try as `adapter.destroy` (they used to run before it,
 * unguarded). `selectAdapter` throws `RuntimeNotSupportedError` synchronously
 * for a runtime triple it doesn't recognize (e.g. a corrupted / hand-edited
 * row) — with the old ordering that throw happened AFTER the row had already
 * transitioned to DELETING, and nothing caught it: the exception propagated
 * out of `Promise.all` in `bulkTeardownEvent` and turned the whole bulk
 * teardown into a 500, leaving every row (including ones from other,
 * unrelated teams) stuck DELETING forever — a retry would just see "already
 * DELETING" and skip them again. Folding the adapter resolution into the try
 * means ANY failure here (unsupported runtime, missing dependency, or the
 * destroy call itself) compensates DELETING -> FAILED and reports
 * `adapterFailed` for just this one row, exactly like a destroy failure
 * always did.
 */
async function prepareBulkAdapterTeardown(
  shared: EventSharedResources,
  tenantId: string,
  updatedAt: string,
  item: Partial<DeploymentItem>,
  runtime: ProblemRuntime,
): Promise<UpdateOutcome> {
  const jobId = String(item.jobId ?? "");
  // [#2571 review-fix] `!shared.ssm` keeps the row dormant-skip (unchanged
  // behavior for a Lambda that hasn't been wired with the per-team credential
  // SSM grants, e.g. staged enablement), matching `plan-builder.ts`'s v1
  // refusal gate on the deploy side. This branch is unreachable in production
  // today — all three `EventSharedResources` builders (`buildEventSharedResources`,
  // `buildScheduledTeardownResources`, `buildScheduledDeployResources`) wire
  // `ssm` unconditionally — but a future regression that un-wires it would
  // otherwise fold live non-AWS rows into `skipped` silently (the exact leak
  // class #2571 fixes). The loud trace makes that regression diagnosable in
  // CloudWatch instead of just showing up as inflated `skipped` counts.
  if (!shared.ssm) {
    logDeployTrace("bulk-teardown.adapter.unavailable", {
      jobId,
      tenantId,
      provider: runtime.provider,
      engine: runtime.engine,
      reason:
        "EventSharedResources.ssm is unwired; row stays dormant-skip until the Lambda is granted per-team credential SSM access",
    });
    return { skip: true };
  }
  if (!jobId) return { skip: true };
  const transitioned = await transitionBulkTargetToDeleting(shared, tenantId, updatedAt, jobId);
  if (!transitioned) return { skip: true };

  const teamSlug = slugify(String(item.teamName ?? ""));
  try {
    const adapter = selectAdapter(
      runtime,
      buildAdapterDependencies({ ...shared, tenantId }, runtime, teamSlug),
    );
    await adapter.destroy({
      jobId,
      namePrefix: String(item.namePrefix ?? ""),
      region: String(item.region ?? ""),
      awsAccountId: String(item.awsAccountId ?? ""),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logDeployTrace("bulk-teardown.adapter.failed", {
      jobId,
      tenantId,
      provider: runtime.provider,
      engine: runtime.engine,
      reason,
    });
    await compensateBulkTeardownPublish(shared, tenantId, jobId, updatedAt);
    return { adapterFailed: jobId };
  }
  return { adapterEnqueued: jobId };
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
  // [Issue #2441 / Phase B2] `markDeletingForBulk` folds the CCF into a
  // `conflict` outcome instead of throwing.
  const repository: DeploymentsLifecyclePort = await resolveDeploymentsRepository(shared);
  const outcome = await repository.markDeletingForBulk(jobId, tenantId, updatedAt);
  return outcome.outcome === "updated";
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
          runtime: shared.runtime,
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
