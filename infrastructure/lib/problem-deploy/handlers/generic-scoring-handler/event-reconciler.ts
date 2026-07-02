import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { bulkTeardownEvent } from "../event-handler/bulk-delete.js";
import { bulkDeployEvent } from "../event-handler/bulk-deploy.js";
import type { EventSharedResources } from "../event-handler/shared.js";

/**
 * #557 / #539: Event status の auto-transition reconciler (= 1-min tick で deployment 集約
 * status を見て Event 行を `READY` / `ARCHIVED` に遷移させる)。
 *
 * ADR-012 Phase 3.B で health-check-handler から本 module に relocate。動作不変、import path 変更のみ。
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
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly deploymentsTableName: string;
  /**
   * [ADR-047] scheduled auto-teardown を発火するための resources (`bulkTeardownEvent` 用)。
   * `buildScheduledTeardownResources()` が返す。 未配線 (= CompetitorAccounts env 無し) なら
   * `undefined` で、 reconciler は scheduled teardown を skip する (= 後方互換・tick を壊さない)。
   */
  readonly teardownDeps?: EventSharedResources;
  /**
   * [ADR-047 follow-up] scheduled auto-deploy を発火するための resources (`bulkDeployEvent` 用)。
   * `buildScheduledDeployResources()` が返す。 未配線 (= Teams / catalog env 無し) なら `undefined`
   * で、 reconciler は scheduled deploy を skip する (= 後方互換・tick を壊さない、 teardownDeps の鏡像)。
   */
  readonly deployDeps?: EventSharedResources;
}

/**
 * [ADR-047] pure: event が「自動撤去すべき」状態か判定する。
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
 * [ADR-047 follow-up] pure: event が「自動デプロイすべき」状態か判定する (teardown の鏡像)。
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
 *   - `PK`: rescue UpdateItem を打つときに要る (= Issue #828 stuck DELETING rescue 経路)。
 *     pre-#828 の旧 row や、 古い fixtures では projection されていない可能性があるので optional。
 *   - `updatedAt`: stuck 判定の閾値比較 (= Issue #828)。 未設定行は rescue skip (= safe default)。
 */
interface DeploymentReconcilerRow {
  readonly PK?: string;
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
  if (eventStatus !== "TEARDOWN") return false;
  if (row.status !== "DELETING") return false;
  if (!Number.isFinite(nowMs)) return false;
  const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs)) return false;
  return nowMs - updatedAtMs >= thresholdMs;
}

async function queryDeploymentRowsForEvent(
  ctx: ReconcileEventStatusesContext,
  event: { tenantId: string; eventId: string },
): Promise<DeploymentReconcilerRow[]> {
  const rows: DeploymentReconcilerRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const depsOut = await ctx.ddb.send(
      new QueryCommand({
        TableName: ctx.deploymentsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        FilterExpression: "eventId = :ev",
        ProjectionExpression: "PK, #status, updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": `TENANT#${event.tenantId}`,
          ":ev": event.eventId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of depsOut.Items ?? []) {
      const cast = item as { PK?: string; status?: string; updatedAt?: string };
      if (!cast.status) continue;
      rows.push({ PK: cast.PK, status: cast.status, updatedAt: cast.updatedAt });
    }
    exclusiveStartKey = depsOut.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return rows;
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
  const rescued = await Promise.all(
    rows.map((row) => rescueStuckDeletingDeployment(ctx, row, nowMs, thresholdMs)),
  );
  return rescued.filter(Boolean).length;
}

async function rescueStuckDeletingDeployment(
  ctx: ReconcileEventStatusesContext,
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number,
): Promise<boolean> {
  const updatedAtMs = staleDeletingUpdatedAtMs(row, nowMs, thresholdMs);
  if (updatedAtMs === undefined || !row.PK) return false;
  try {
    await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.deploymentsTableName,
        Key: { PK: row.PK, SK: "META" },
        UpdateExpression:
          "SET #status = :failed, updatedAt = :now, #reason = :reason REMOVE GSI2PK, GSI2SK",
        ConditionExpression: "#status = :deleting",
        ExpressionAttributeNames: { "#status": "status", "#reason": "failureReason" },
        ExpressionAttributeValues: {
          ":deleting": "DELETING",
          ":failed": "FAILED",
          ":now": new Date(nowMs).toISOString(),
          ":reason": `reconciler: stuck DELETING > ${Math.floor(thresholdMs / 60_000)} min, treating as FAILED to unblock Event TEARDOWN (#828)`,
        },
      }),
    );
    console.warn("[generic-scoring] rescued stuck DELETING deployment", {
      PK: row.PK,
      staleForMs: nowMs - updatedAtMs,
    });
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    console.warn("[generic-scoring] stuck-DELETING rescue failed", {
      PK: row.PK,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function staleDeletingUpdatedAtMs(
  row: DeploymentReconcilerRow,
  nowMs: number,
  thresholdMs: number,
): number | undefined {
  if (row.status !== "DELETING") return undefined;
  const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < thresholdMs) return undefined;
  return updatedAtMs;
}

/**
 * Events table を scan して `DEPLOYING` / `READY` / `TEARDOWN` 状態の Event について
 * 自動遷移を判定 (#557 #539 / Issue #1038 P0 #3):
 *   - `DEPLOYING`: 子 deployment 全 terminal → `READY`
 *   - `READY` + `endsAt` 経過 → `ENDED`
 *   - `TEARDOWN`: 子 deployment 全 終端 → `ARCHIVED`
 *
 * 各 Event の判定は **並列**: 1 件遅い tenant が他を block しない。Update が CCF
 * (= operator 手動遷移などの race) で失敗した行は silent skip (= 次の tick で再評価)。
 *
 * Scan limit 100: TenkaCloud MVP 規模 (events ~10 件 / tenant、~5 tenants) で 1 tick で
 * 全件処理できる範囲。Phase 2+ で増えたら GSI3 (PK=STATUS) で query 化を検討。
 */
export async function reconcileEventStatuses(
  ctx: ReconcileEventStatusesContext,
  nowIso: string,
): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ctx.ddb.send(
      new ScanCommand({
        TableName: ctx.eventsTableName,
        // [ADR-047] ENDED も拾う (= teardownAt 経過の自動撤去対象)。 teardownAt / teardownFiredAt を投影。
        // [ADR-047 follow-up] DRAFT も拾う (= deployAt 経過の自動デプロイ対象)。 deployAt / deployFiredAt を投影。
        ProjectionExpression:
          "PK, tenantId, eventId, #status, endsAt, teardownAt, teardownFiredAt, deployAt, deployFiredAt",
        ExpressionAttributeNames: { "#status": "status" },
        FilterExpression:
          "#status = :deploying OR #status = :ready OR #status = :teardown OR #status = :ended OR #status = :draft",
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":ready": "READY",
          ":teardown": "TEARDOWN",
          ":ended": "ENDED",
          ":draft": "DRAFT",
        },
        Limit: 100,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Array<{
      PK?: string;
      tenantId?: string;
      eventId?: string;
      status?: string;
      endsAt?: string;
      teardownAt?: string;
      teardownFiredAt?: string;
      deployAt?: string;
      deployFiredAt?: string;
    }>;

    const nowMs = Date.parse(nowIso);
    await Promise.all(items.map((event) => reconcileSingleEvent(ctx, event, nowIso, nowMs)));

    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}

async function reconcileSingleEvent(
  ctx: ReconcileEventStatusesContext,
  event: {
    readonly PK?: string;
    readonly tenantId?: string;
    readonly eventId?: string;
    readonly status?: string;
    readonly endsAt?: string;
    readonly teardownAt?: string;
    readonly teardownFiredAt?: string;
    readonly deployAt?: string;
    readonly deployFiredAt?: string;
  },
  nowIso: string,
  nowMs: number,
): Promise<void> {
  if (!event.tenantId || !event.eventId || !event.status || !event.PK) return;
  const eventStatus: string = event.status;

  // [ADR-047 follow-up] scheduled auto-deploy: deployAt 経過の DRAFT を自動 deploy。
  // deployDeps 未配線 (= Teams / catalog env 無し) なら skip (= dormant、 後方互換)。
  // bulkDeployEvent が status を DRAFT → DEPLOYING に倒すので、 通常遷移より先に発火し early return。
  if (resolveScheduledDeployDue(event, nowMs) && ctx.deployDeps) {
    await fireScheduledAction(
      ctx,
      ctx.deployDeps,
      { PK: event.PK, tenantId: event.tenantId, eventId: event.eventId, nowMs, nowIso },
      "deploy",
      bulkDeployEvent,
      "deployFiredAt",
    );
    return;
  }
  // DRAFT は通常の status 遷移対象外 (resolveEventStatusTransition は DRAFT で undefined)。
  // 自動 deploy が due でない / dormant な DRAFT は子 deployment query 無しで早期 return
  // (= 未 deploy なので query しても 0 件、 RCU / Lambda 時間の無駄を避ける)。
  if (eventStatus === "DRAFT") return;

  // [ADR-047] scheduled auto-teardown: teardownAt 経過の READY/ENDED を自動撤去 (課金リーク防止)。
  // teardownDeps 未配線 (= CompetitorAccounts env 無し) なら skip (= dormant、 後方互換)。
  // bulkTeardownEvent が status を TEARDOWN に倒すので、 通常遷移より先に発火し early return する。
  if (resolveScheduledTeardownDue(event, nowMs) && ctx.teardownDeps) {
    await fireScheduledAction(
      ctx,
      ctx.teardownDeps,
      { PK: event.PK, tenantId: event.tenantId, eventId: event.eventId, nowMs, nowIso },
      "teardown",
      bulkTeardownEvent,
      "teardownFiredAt",
    );
    return;
  }

  // Issue #1038 P0 #3: READY → ENDED は deployment row を見る必要が無い (= endsAt のみで判定)。
  // 子 deployment を query しないことで RCU / Lambda 時間を節約。
  if (eventStatus === "READY") {
    const next = resolveEventStatusTransition(eventStatus, [], { endsAt: event.endsAt, nowMs });
    if (!next) return;
    await applyEventStatusTransition(ctx, {
      PK: event.PK,
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
  // Issue #828: TEARDOWN で `DELETING` 行が `STUCK_DELETING_THRESHOLD_MS` 以上停滞していれば
  // FAILED に倒す (= bulk-delete publish chunk 失敗 / State Machine 未起動 / 競技者の手動 stack
  // 削除で silent path に倒れた orphan 行を救済し、 ARCHIVED 自動遷移を解錠する)。
  // DDB Update は side-effect で発火、 同 tick の transition 判定には rescue 後の値を
  // 想定した `adjustedStatuses` を使う (= 次 tick を待たずに同 tick で ARCHIVED 化可能)。
  if (eventStatus === "TEARDOWN" && Number.isFinite(nowMs)) {
    await rescueStuckDeletingDeployments(ctx, depRows, nowMs);
  }
  const adjustedStatuses = depRows.map((r) =>
    isStuckDeletingForTeardown(eventStatus, r, nowMs) ? "FAILED" : r.status,
  );
  const next = resolveEventStatusTransition(eventStatus, adjustedStatuses);
  if (!next) return;
  await applyEventStatusTransition(ctx, {
    PK: event.PK,
    tenantId: event.tenantId,
    eventId: event.eventId,
    from: eventStatus,
    to: next,
    nowIso,
  });
}

async function applyEventStatusTransition(
  ctx: ReconcileEventStatusesContext,
  args: {
    readonly PK: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly from: string;
    readonly to: "READY" | "ENDED" | "ARCHIVED";
    readonly nowIso: string;
  },
): Promise<void> {
  try {
    await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.eventsTableName,
        Key: { PK: args.PK, SK: "META" },
        UpdateExpression: "SET #status = :next, updatedAt = :now",
        // race 防止: 期待 current status と一致しているときのみ更新 (= operator が
        // 手動 archive / 再 deploy で先に動かしてたら CCF で skip)。
        ConditionExpression: "tenantId = :tenant AND #status = :current",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":tenant": args.tenantId,
          ":current": args.from,
          ":next": args.to,
          ":now": args.nowIso,
        },
      }),
    );
    console.log("[generic-scoring] Event status auto-transition", {
      eventId: args.eventId,
      from: args.from,
      to: args.to,
    });
  } catch (err) {
    const code = (err as { name?: string })?.name ?? "";
    if (code === "ConditionalCheckFailedException") return;
    console.warn("[generic-scoring] Event status update failed", {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * [ADR-047 / ADR-047 follow-up] scheduled teardown / deploy を発火する (旧 fireScheduledTeardown /
 * fireScheduledDeploy の鏡像を統合、 issue #2223)。 `bulkTeardownEvent` / `bulkDeployEvent` を
 * `publishFn` として受け取り再利用する (= 手動「Event を削除」/「Deploy」と同一経路)。 直後に
 * teardownFiredAt / deployFiredAt を記録 (= 二重発火防止の補助 + 監査)。 失敗は warn で握り潰す
 * (= 次 tick で再評価。 status guard が一次冪等なので毎分 tick / 採点を巻き込まない)。
 */
async function fireScheduledAction(
  ctx: ReconcileEventStatusesContext,
  deps: EventSharedResources,
  args: {
    readonly PK: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly nowMs: number;
    readonly nowIso: string;
  },
  kind: "teardown" | "deploy",
  publishFn: (
    deps: EventSharedResources,
    tenantId: string,
    eventId: string,
    nowMs: number,
  ) => Promise<{ readonly kind: string; readonly result?: { readonly enqueued: number } }>,
  firedAttr: "teardownFiredAt" | "deployFiredAt",
): Promise<void> {
  const label = kind === "teardown" ? "ADR-047" : "ADR-047 follow-up";
  try {
    const outcome = await publishFn(deps, args.tenantId, args.eventId, args.nowMs);
    console.log(`[generic-scoring] scheduled auto-${kind} fired (${label})`, {
      eventId: args.eventId,
      outcome: outcome.kind,
      enqueued: outcome.kind === "ok" ? outcome.result?.enqueued : undefined,
    });
    await recordFired(ctx, args, firedAttr);
  } catch (err) {
    console.warn(`[generic-scoring] scheduled auto-${kind} failed`, {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * scheduled action の発火記録 (teardownFiredAt / deployFiredAt)。 二重発火防止の補助 + 監査。
 * `attribute_not_exists` で冪等化し、 ConditionalCheckFailedException (= 既発火) は握り潰す。
 * `firedAttr` は固定の literal union なので UpdateExpression への injection はない。
 */
async function recordFired(
  ctx: ReconcileEventStatusesContext,
  args: {
    readonly PK: string;
    readonly tenantId: string;
    readonly eventId: string;
    readonly nowIso: string;
  },
  firedAttr: "teardownFiredAt" | "deployFiredAt",
): Promise<void> {
  try {
    await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.eventsTableName,
        Key: { PK: args.PK, SK: "META" },
        UpdateExpression: `SET ${firedAttr} = :now`,
        ConditionExpression: `tenantId = :tenant AND attribute_not_exists(${firedAttr})`,
        ExpressionAttributeValues: { ":tenant": args.tenantId, ":now": args.nowIso },
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return;
    console.warn(`[generic-scoring] recordFired(${firedAttr}) failed`, {
      eventId: args.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
