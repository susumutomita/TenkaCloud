import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import type { EventRecord, ScheduleFiredKind } from "../../control-data/events-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { DEPLOY_STUCK_RECOVERY_THRESHOLD_MS } from "../../deploy-cost-model.js";
import { bulkTeardownEvent } from "../event-handler/bulk-delete.js";
import { bulkDeployEvent } from "../event-handler/bulk-deploy.js";
import { type EventSharedResources, resolveEventsRepository } from "../event-handler/shared.js";
import { resolveDeploymentsRepository } from "./shared.js";

/**
 * #557 / #539: Event status の auto-transition reconciler (= 1-min tick で deployment 集約
 * status を見て Event 行を `READY` / `ARCHIVED` に遷移させる)。
 *
 * health-check-handler から本 module に relocate。動作不変、import path 変更のみ。
 *
 * 関数 2 つ:
 *   1. `resolveEventStatusTransition` (pure function、入出力のみ)
 *   2. `reconcileEventStatuses` (DDB I/O 越し、Scan → Query × N → conditional Update のシーケンス)
 */

/**
 * #557 / #539: Event status の auto-transition 判定 (pure function、test-friendly)。
 *
 * - `DEPLOYING`: 子 deployment が **全て terminal** (`COMPLETE` / `FAILED`) → `READY`。
 *   1 件でも進行中 (`PENDING` / `IN_PROGRESS`) があれば `undefined` (= 触らない)。
 * - `READY`: `endsAt` が現在時刻を過ぎていたら → `ENDED` (Issue #1038 P0 #3、 2026-05-18)。
 *   user 観測「終了時刻を過ぎたのにイベントが終わらない」 を解消するため、 endsAt 経過後の
 *   1 分以内に自動 ENDED 遷移する。 endsAt 不在の event は無期限なので `undefined`。
 * - `TEARDOWN`: 子 deployment が **全て終端** (`DELETED` / `FAILED`) → `ARCHIVED`。
 *   `DELETING` が残っていれば `undefined`。
 * - 子 deployment 0 件: `undefined` (= bulk-deploy/bulk-delete 前の race state、触らない)。
 * - その他 status (`DRAFT` / `ENDED` / `ARCHIVED`): caller でフィルタ済前提だが
 *   defense-in-depth で `undefined`。
 *
 * `FAILED` を terminal に含む理由: deploy が失敗した行も「これ以上進行しない」状態なので
 * Event 全体としては前進可能 (= operator 視点で再実行 or skip 判断)。同様に teardown 失敗も
 * 引きずらない (= 最終手段は operator 手動削除)。
 */
export function resolveEventStatusTransition(
  eventStatus: string,
  deploymentStatuses: readonly string[],
  context?: { readonly endsAt?: string; readonly nowMs?: number },
): "READY" | "ENDED" | "ARCHIVED" | undefined {
  if (eventStatus === "READY") {
    // Issue #1038 P0 #3: endsAt 経過で自動 ENDED 遷移。 deployment status は不要 (= 採点 gate は
    // event-gate.ts が endsAt から既に judge している)。
    const endsAt = context?.endsAt;
    const nowMs = context?.nowMs;
    if (!endsAt || nowMs === undefined) return undefined;
    const endsAtMs = Date.parse(endsAt);
    if (!Number.isFinite(endsAtMs)) return undefined;
    return nowMs >= endsAtMs ? "ENDED" : undefined;
  }
  if (deploymentStatuses.length === 0) return undefined;
  if (eventStatus === "DEPLOYING") {
    const allTerminal = deploymentStatuses.every((s) => s === "COMPLETE" || s === "FAILED");
    return allTerminal ? "READY" : undefined;
  }
  if (eventStatus === "TEARDOWN") {
    const allDone = deploymentStatuses.every((s) => s === "DELETED" || s === "FAILED");
    return allDone ? "ARCHIVED" : undefined;
  }
  return undefined;
}

export interface ReconcileEventStatusesContext {
  /** [#2527 Slice 4] Injected control-data runtime (from the Lambda entrypoint's instance). */
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly deploymentsTableName: string;
  /**
   * scheduled auto-teardown を発火するための resources (`bulkTeardownEvent` 用)。
   * `buildScheduledTeardownResources()` が返す。 未配線 (= CompetitorAccounts env 無し) なら
   * `undefined` で、 reconciler は scheduled teardown を skip する (= 後方互換・tick を壊さない)。
   */
  readonly teardownDeps?: EventSharedResources;
  /**
   * scheduled auto-deploy を発火するための resources (`bulkDeployEvent` 用)。
   * `buildScheduledDeployResources()` が返す。 未配線 (= Teams / catalog env 無し) なら `undefined`
   * で、 reconciler は scheduled deploy を skip する (= 後方互換・tick を壊さない、 teardownDeps の鏡像)。
   */
  readonly deployDeps?: EventSharedResources;
}

/**
 * pure: event が「自動撤去すべき」状態か判定する。
 *
 * 条件: `teardownAt` 設定済 かつ `now >= teardownAt` かつ status が撤去可能 (= `READY` / `ENDED`、
 * すなわち deploy 済で採点が走る/終わった状態) かつ未発火 (`teardownFiredAt` 無し)。
 *
 * `DEPLOYING` (deploy 進行中) は撤去しない (= 次 tick で READY 化後に拾う、 mid-deploy 破壊回避)。
 * `DRAFT` (未 deploy) / `TEARDOWN` / `ARCHIVED` も対象外。 status 遷移 (→ TEARDOWN) が一次の
 * 冪等ガードで、 `teardownFiredAt` は二重発火防止の補助。
 */
export function resolveScheduledTeardownDue(
  event: {
    readonly status?: string;
    readonly teardownAt?: string;
    readonly teardownFiredAt?: string;
  },
  nowMs: number,
): boolean {
  if (event.teardownFiredAt) return false;
  if (event.status !== "READY" && event.status !== "ENDED") return false;
  if (!event.teardownAt) return false;
  const teardownAtMs = Date.parse(event.teardownAt);
  if (!Number.isFinite(teardownAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= teardownAtMs;
}

/**
 * pure: event が「自動デプロイすべき」状態か判定する (teardown の鏡像)。
 *
 * 条件: `deployAt` 設定済 かつ `now >= deployAt` かつ status が `DRAFT` (= 未 deploy) かつ
 * 未発火 (`deployFiredAt` 無し)。
 *
 * `DRAFT` 限定にする理由: 一度でも deploy 済 (`DEPLOYING` 以降) の event を自動再 deploy すると
 * 進行中の競技 stack を再作成しかねないため。 status 遷移 (DRAFT → DEPLOYING、 bulkDeployEvent が
 * 倒す) が一次の冪等ガードで、 `deployFiredAt` は二重発火防止の補助 (teardownFiredAt と対称)。
 */
export function resolveScheduledDeployDue(
  event: {
    readonly status?: string;
    readonly deployAt?: string;
    readonly deployFiredAt?: string;
  },
  nowMs: number,
): boolean {
  if (event.deployFiredAt) return false;
  if (event.status !== "DRAFT") return false;
  if (!event.deployAt) return false;
  const deployAtMs = Date.parse(event.deployAt);
  if (!Number.isFinite(deployAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= deployAtMs;
}

/**
 * Issue #828: DELETING のまま 30 分以上停滞している deployment 行を 「stuck」 とみなして
 * reconciler が FAILED に倒すための閾値。 30 分は CodeBuild + CFn DeleteStack の最遅成功
 * パス (= CloudFront / Route53 等の slow-delete + retry) より長く取った余裕値。
 *
 * 想定する stuck の原因:
 *   - bulk-delete が `status=DELETING` を書いた後、 publish chunk が失敗 (= EventBridge
 *     PutEvents が partial fail) して State Machine が起動しなかった
 *   - State Machine が起動したが Mark{Deleted,Failed} に到達せずに timeout (= 60 min 上限)
 *   - 競技者が AWS Console で stack を手動削除 → CFn DeleteStack が "stack does not exist"
 *     で 404 → State Machine の catch path が走らず、 silent に放置 (= 既知 issue B)
 *
 * いずれも結果として Event TEARDOWN が ARCHIVED に進まない。 本 reconciler は次 tick で
 * 全 stuck 行を FAILED に倒し、 既存 `resolveEventStatusTransition` が FAILED を terminal
 * 扱いするため自然に ARCHIVED に遷移する。
 */
const STUCK_DELETING_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Project field set for the reconciler:
 *   - `status`: 必須 (= 既存 `resolveEventStatusTransition` の入力)
 *   - `jobId`: rescue UpdateItem を打つときに `DEPLOYMENT#<jobId>` を再構築する。
 *   - `updatedAt`: stuck 判定の閾値比較 (= Issue #828)。 未設定行は rescue skip (= safe default)。
 */
interface DeploymentReconcilerRow {
  readonly jobId?: string;
  readonly status: string;
  readonly updatedAt?: string;
}

/**
 * Issue #828: `DELETING` 行が TEARDOWN scope で stuck (= threshold 超え) か判定する pure helper。
 * test で時刻入力を制御するため、 reconcileEventStatuses 本体と rescueStuckDeletingDeployments
 * の両方から呼び出される。
 */
export function isStuckDeletingForTeardown(
  eventStatus: string,
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number = STUCK_DELETING_THRESHOLD_MS,
): boolean {
  return (
    eventStatus === "TEARDOWN" &&
    staleDeploymentUpdatedAtMs(row, nowMs, thresholdMs, ["DELETING"]) !== undefined
  );
}

/**
 * Issue #2651: deploy State Machine の timeout と grace period を超えても `PENDING` /
 * `IN_PROGRESS` のまま残った deployment を判定する。Event が `DEPLOYING` の場合だけ
 * rescue し、通常の create path や terminal 行には触れない。
 */
export function isStuckCreatingForDeploy(
  eventStatus: string,
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number = DEPLOY_STUCK_RECOVERY_THRESHOLD_MS,
): boolean {
  return (
    eventStatus === "DEPLOYING" &&
    staleDeploymentUpdatedAtMs(row, nowMs, thresholdMs, ["PENDING", "IN_PROGRESS"]) !== undefined
  );
}

async function queryDeploymentRowsForEvent(
  ctx: ReconcileEventStatusesContext,
  event: { tenantId: string; eventId: string },
): Promise<DeploymentReconcilerRow[]> {
  const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(ctx);
  const rows = await repository.listReconcilerRowsByEvent(event.tenantId, event.eventId);
  return rows.map((row) => ({ jobId: row.jobId, status: row.status, updatedAt: row.updatedAt }));
}

/**
 * Issue #828: `status=DELETING` 行が `STUCK_DELETING_THRESHOLD_MS` 以上更新されていなければ、
 * conditional UpdateItem で `status=FAILED` に倒す。 race 防止のため `status=DELETING` 一致時のみ
 * 書く (= State Machine が同時に MarkDeleted/MarkFailed したら CCF で skip)。
 *
 * 「rescue した行数」 を返す。 caller が log / next-tick の判断に使える。
 */
export async function rescueStuckDeletingDeployments(
  ctx: ReconcileEventStatusesContext,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
  thresholdMs: number = STUCK_DELETING_THRESHOLD_MS,
): Promise<number> {
  return (await rescueStuckDeletingDeploymentIds(ctx, rows, nowMs, thresholdMs)).size;
}

/**
 * Issue #2651: stuck create 行を独立した reconciler Lambda から conditional update する。
 * status writer 自身が利用不能でも毎分再試行でき、Event の `DEPLOYING` 固着を解消する。
 */
export async function rescueStuckCreatingDeployments(
  ctx: ReconcileEventStatusesContext,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
  thresholdMs: number = DEPLOY_STUCK_RECOVERY_THRESHOLD_MS,
): Promise<number> {
  return (await rescueStuckCreatingDeploymentIds(ctx, rows, nowMs, thresholdMs)).size;
}

type StuckRecoveryKind = "creating" | "deleting";

async function rescueStuckDeletingDeploymentIds(
  ctx: ReconcileEventStatusesContext,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
  thresholdMs: number,
): Promise<ReadonlySet<string>> {
  return rescueStuckDeploymentIds(ctx, rows, nowMs, thresholdMs, "deleting");
}

async function rescueStuckCreatingDeploymentIds(
  ctx: ReconcileEventStatusesContext,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
  thresholdMs: number,
): Promise<ReadonlySet<string>> {
  return rescueStuckDeploymentIds(ctx, rows, nowMs, thresholdMs, "creating");
}

async function rescueStuckDeploymentIds(
  ctx: ReconcileEventStatusesContext,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
  thresholdMs: number,
  kind: StuckRecoveryKind,
): Promise<ReadonlySet<string>> {
  const rescued = await Promise.all(
    rows.map((row) => rescueStuckDeployment(ctx, row, nowMs, thresholdMs, kind)),
  );
  return new Set(rescued.filter((jobId): jobId is string => jobId !== undefined));
}

async function rescueStuckDeployment(
  ctx: ReconcileEventStatusesContext,
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number,
  kind: StuckRecoveryKind,
): Promise<string | undefined> {
  const statuses = kind === "creating" ? ["PENDING", "IN_PROGRESS"] : ["DELETING"];
  const updatedAtMs = staleDeploymentUpdatedAtMs(row, nowMs, thresholdMs, statuses);
  if (updatedAtMs === undefined || !row.jobId) return undefined;

  const pk = `DEPLOYMENT#${row.jobId}`;
  try {
    const repository: DeploymentsQueryPort & DeploymentsLifecyclePort =
      await resolveDeploymentsRepository(ctx);
    const outcome = await markStuckDeploymentFailed(
      repository,
      row.jobId,
      recoveryReason(kind, thresholdMs),
      new Date(nowMs).toISOString(),
      kind,
    );
    if (outcome.outcome !== "updated") return undefined;
    console.warn(`[generic-scoring] rescued stuck ${kind} deployment`, {
      PK: pk,
      staleForMs: nowMs - updatedAtMs,
    });
    return row.jobId;
  } catch (err) {
    console.warn(`[generic-scoring] stuck-${kind} rescue failed`, {
      PK: pk,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function markStuckDeploymentFailed(
  repository: DeploymentsLifecyclePort,
  jobId: string,
  reason: string,
  at: string,
  kind: StuckRecoveryKind,
) {
  return kind === "creating"
    ? repository.markStuckCreatingFailed(jobId, reason, at)
    : repository.markStuckDeletingFailed(jobId, reason, at);
}

function recoveryReason(kind: StuckRecoveryKind, thresholdMs: number): string {
  const minutes = Math.floor(thresholdMs / 60_000);
  return kind === "creating"
    ? `reconciler: stuck PENDING/IN_PROGRESS > ${minutes} min after DeployCreate timeout, treating as FAILED to unblock Event DEPLOYING (#2651)`
    : `reconciler: stuck DELETING > ${minutes} min, treating as FAILED to unblock Event TEARDOWN (#828)`;
}

function staleDeploymentUpdatedAtMs(
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number,
  statuses: readonly string[],
): number | undefined {
  if (!statuses.includes(row.status) || !Number.isFinite(nowMs)) return undefined;
  const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < thresholdMs) return undefined;
  return updatedAtMs;
}

/**
 * [#557 #539 / #1038 P0 #3] `DEPLOYING` / `READY` / `TEARDOWN` / `ENDED` / `DRAFT` 状態の
 * Event について自動遷移を判定する:
 *   - `DEPLOYING`: 子 deployment 全 terminal → `READY`
 *   - `READY` + `endsAt` 経過 → `ENDED`
 *   - `TEARDOWN`: 子 deployment 全 終端 → `ARCHIVED`
 *
 * 各 Event の判定は **並列**: 1 件遅い tenant が他を block しない。Update が CCF
 * (= operator 手動遷移などの race) で失敗した行は silent skip (= 次の tick で再評価)。
 *
 * [#2438 / Phase A3] Events への raw Scan は repository seam
 * (`listEventsByStatus`) に移設済み。 TenkaCloud MVP 規模 (events ~10 件 / tenant、
 * ~5 tenants) で 1 tick 全件を drain できる範囲。 Phase 2+ で増えたら backend 側の
 * query 化 (GSI3 等) を検討する。
 */
const RECONCILED_STATUSES = ["DEPLOYING", "READY", "TEARDOWN", "ENDED", "DRAFT"] as const;

export async function reconcileEventStatuses(
  ctx: ReconcileEventStatusesContext,
  nowIso: string,
): Promise<void> {
  await pruneExpiredControlData(ctx.runtime, nowIso);
  const repository = await resolveEventsRepository(ctx);
  const events = await repository.listEventsByStatus(RECONCILED_STATUSES);
  const nowMs = Date.parse(nowIso);
  await Promise.all(events.map((event) => reconcileSingleEvent(ctx, event, nowIso, nowMs)));
}

async function pruneExpiredControlData(runtime: ControlDataRuntime, nowIso: string): Promise<void> {
  if (!runtime.needsManualPrune()) return;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return;
  const nowEpochSeconds = Math.floor(nowMs / 1000);
  await Promise.all([
    runtime.resolveEventsRepository({}),
    runtime.resolveTeamsRepository({}),
    runtime.resolveNotificationsRepository({}),
    // [Issue #2442 / Phase C3] Disruptions joins the manual-prune tick (audit / fire-claim /
    // recurring / exec-claim rows all carry `expiresAt` — same TTL-equivalent sweep as
    // Events/Teams/Notifications).
    runtime.resolveDisruptionsRepository({}),
    // [Issue #2442 / Phase C4] AdminAuditLog joins the manual-prune tick too (rows carry `ttl`,
    // DynamoDB's native TTL attribute name — no `ddb`/`adminAuditLogTableName` needed here since
    // `needsManualPrune()` above already gates this branch to the pure-SQL backend).
    runtime.resolveAdminAuditLogRepository({}),
    runtime.resolveDeploymentsRepository({}),
  ])
    .then(([events, teams, notifications, disruptions, adminAuditLog, deployments]) =>
      Promise.all([
        events.pruneExpired(nowEpochSeconds),
        teams.pruneExpired(nowEpochSeconds),
        notifications.pruneExpired(nowEpochSeconds),
        disruptions.pruneExpired(nowEpochSeconds),
        adminAuditLog.pruneExpired(nowEpochSeconds),
        deployments.sweepExpiredCoordinationState(nowEpochSeconds),
      ]),
    )
    .catch((err: unknown) => {
      console.warn("[generic-scoring] manual prune failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
}

async function reconcileSingleEvent(
  ctx: ReconcileEventStatusesContext,
  event: EventRecord,
  nowIso: string,
  nowMs: number,
): Promise<void> {
  if (!event.tenantId || !event.eventId || !event.status) return;
  const eventStatus: string = event.status;

  // scheduled auto-deploy: deployAt 経過の DRAFT を自動 deploy。
  // deployDeps 未配線 (= Teams / catalog env 無し) なら skip (= dormant、 後方互換)。
  // bulkDeployEvent が status を DRAFT → DEPLOYING に倒すので、 通常遷移より先に発火し early return。
  if (resolveScheduledDeployDue(event, nowMs) && ctx.deployDeps) {
    await fireScheduledAction(
      ctx,
      ctx.deployDeps,
      { tenantId: event.tenantId, eventId: event.eventId, nowMs, nowIso },
      "deploy",
      bulkDeployEvent,
    );
    return;
  }
  // DRAFT は通常の status 遷移対象外 (resolveEventStatusTransition は DRAFT で undefined)。
  // 自動 deploy が due でない / dormant な DRAFT は子 deployment query 無しで早期 return
  // (= 未 deploy なので query しても 0 件、 RCU / Lambda 時間の無駄を避ける)。
  if (eventStatus === "DRAFT") return;

  // scheduled auto-teardown: teardownAt 経過の READY/ENDED を自動撤去 (課金リーク防止)。
  // teardownDeps 未配線 (= CompetitorAccounts env 無し) なら skip (= dormant、 後方互換)。
  // bulkTeardownEvent が status を TEARDOWN に倒すので、 通常遷移より先に発火し early return する。
  if (resolveScheduledTeardownDue(event, nowMs) && ctx.teardownDeps) {
    await fireScheduledAction(
      ctx,
      ctx.teardownDeps,
      { tenantId: event.tenantId, eventId: event.eventId, nowMs, nowIso },
      "teardown",
      bulkTeardownEvent,
    );
    return;
  }

  // Issue #1038 P0 #3: READY → ENDED は deployment row を見る必要が無い (= endsAt のみで判定)。
  // 子 deployment を query しないことで RCU / Lambda 時間を節約。
  if (eventStatus === "READY") {
    const next = resolveEventStatusTransition(eventStatus, [], { endsAt: event.endsAt, nowMs });
    if (!next) return;
    await applyEventStatusTransition(ctx, {
      tenantId: event.tenantId,
      eventId: event.eventId,
      from: eventStatus,
      to: next,
      nowIso,
    });
    return;
  }

  // 子 deployments を GSI1 (TENANT#) で query → eventId filter 後の全 page を集約。
  const depRows = await queryDeploymentRowsForEvent(ctx, {
    tenantId: event.tenantId,
    eventId: event.eventId,
  });
  // A row is treated as FAILED in this tick only after its conditional rescue
  // write succeeds. A conflict or backend error must not advance the parent
  // Event from the stale projection alone.
  const rescuedJobIds = await rescueStuckDeploymentsForEvent(ctx, eventStatus, depRows, nowMs);
  const adjustedStatuses = depRows.map((row) =>
    row.jobId && rescuedJobIds.has(row.jobId) ? "FAILED" : row.status,
  );
  const next = resolveEventStatusTransition(eventStatus, adjustedStatuses);
  if (!next) return;
  await applyEventStatusTransition(ctx, {
    tenantId: event.tenantId,
    eventId: event.eventId,
    from: eventStatus,
    to: next,
    nowIso,
  });
}

async function rescueStuckDeploymentsForEvent(
  ctx: ReconcileEventStatusesContext,
  eventStatus: string,
  rows: readonly DeploymentReconcilerRow[],
  nowMs: number,
): Promise<ReadonlySet<string>> {
  if (!Number.isFinite(nowMs)) return new Set();
  if (eventStatus === "DEPLOYING") {
    return rescueStuckCreatingDeploymentIds(ctx, rows, nowMs, DEPLOY_STUCK_RECOVERY_THRESHOLD_MS);
  }
  if (eventStatus === "TEARDOWN") {
    return rescueStuckDeletingDeploymentIds(ctx, rows, nowMs, STUCK_DELETING_THRESHOLD_MS);
  }
  return new Set();
}

async function applyEventStatusTransition(
  ctx: ReconcileEventStatusesContext,
  args: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly from: string;
    readonly to: "READY" | "ENDED" | "ARCHIVED";
    readonly nowIso: string;
  },
): Promise<void> {
  try {
    // 楽観 CAS は repository seam の `transitionStatus` に移設。 conflict (= operator が
    // 手動 archive / 再 deploy で先に動かしてたレース) は skip し次 tick で再評価する
    // (= 旧 CCF 握り潰しと同じ、 probe read も費やさない)。 [#2450] resolver は async 化したが
    // config エラー (turso env 不足) も既存 catch で warn + skip され次 tick で再評価される。
    const repository = await resolveEventsRepository(ctx);
    const result = await repository.transitionStatus(
      args.tenantId,
      args.eventId,
      args.from,
      args.to,
      args.nowIso,
    );
    if (result.outcome !== "updated") return;
    console.log("[generic-scoring] Event status auto-transition", {
      eventId: args.eventId,
      from: args.from,
      to: args.to,
    });
  } catch (err) {
    console.warn("[generic-scoring] Event status update failed", {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * scheduled teardown / deploy を発火する (旧 fireScheduledTeardown /
 * fireScheduledDeploy の鏡像を統合、 issue #2223)。 `bulkTeardownEvent` / `bulkDeployEvent` を
 * `publishFn` として受け取り再利用する (= 手動「Event を削除」/「Deploy」と同一経路)。 直後に
 * teardownFiredAt / deployFiredAt を記録 (= 二重発火防止の補助 + 監査)。 失敗は warn で握り潰す
 * (= 次 tick で再評価。 status guard が一次冪等なので毎分 tick / 採点を巻き込まない)。
 */
async function fireScheduledAction(
  ctx: ReconcileEventStatusesContext,
  deps: EventSharedResources,
  args: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly nowMs: number;
    readonly nowIso: string;
  },
  kind: ScheduleFiredKind,
  publishFn: (
    deps: EventSharedResources,
    tenantId: string,
    eventId: string,
    nowMs: number,
  ) => Promise<{ readonly kind: string; readonly result?: { readonly enqueued: number } }>,
): Promise<void> {
  try {
    const outcome = await publishFn(deps, args.tenantId, args.eventId, args.nowMs);
    console.log(`[generic-scoring] scheduled auto-${kind} fired`, {
      eventId: args.eventId,
      outcome: outcome.kind,
      enqueued: outcome.kind === "ok" ? outcome.result?.enqueued : undefined,
    });
    await recordFired(ctx, args, kind);
  } catch (err) {
    console.warn(`[generic-scoring] scheduled auto-${kind} failed`, {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * scheduled action の発火記録 (teardownFiredAt / deployFiredAt)。 二重発火防止の補助 + 監査。
 * [#2437 Phase A2] 冪等な条件付き書き込みは repository seam の `markScheduleFired` に移設。
 * conflict (= 既発火、 attribute_not_exists 不成立) は握り潰す (旧 CCF 握り潰しと同じ挙動)。
 */
async function recordFired(
  ctx: ReconcileEventStatusesContext,
  args: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly nowIso: string;
  },
  kind: ScheduleFiredKind,
): Promise<void> {
  const firedAttr = kind === "teardown" ? "teardownFiredAt" : "deployFiredAt";
  try {
    const repository = await resolveEventsRepository(ctx);
    await repository.markScheduleFired(args.tenantId, args.eventId, kind, args.nowIso);
  } catch (err) {
    console.warn(`[generic-scoring] recordFired(${firedAttr}) failed`, {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
