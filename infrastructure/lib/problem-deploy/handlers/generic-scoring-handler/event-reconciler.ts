import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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
 * - `TEARDOWN`: 子 deployment が **全て終端** (`DELETED` / `FAILED`) → `ARCHIVED`。
 *   `DELETING` が残っていれば `undefined`。
 * - 子 deployment 0 件: `undefined` (= bulk-deploy/bulk-delete 前の race state、触らない)。
 * - その他 status (`DRAFT` / `READY` / `ENDED` / `ARCHIVED`): caller でフィルタ済前提だが
 *   defense-in-depth で `undefined`。
 *
 * `FAILED` を terminal に含む理由: deploy が失敗した行も「これ以上進行しない」状態なので
 * Event 全体としては前進可能 (= operator 視点で再実行 or skip 判断)。同様に teardown 失敗も
 * 引きずらない (= 最終手段は operator 手動削除)。
 */
export function resolveEventStatusTransition(
  eventStatus: string,
  deploymentStatuses: readonly string[],
): "READY" | "ARCHIVED" | undefined {
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
  let rescued = 0;
  await Promise.all(
    rows.map(async (row) => {
      if (row.status !== "DELETING") return;
      if (!row.PK) return; // projection 漏れ (= 旧 fixture) は rescue skip
      const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
      if (!Number.isFinite(updatedAtMs)) return;
      if (nowMs - updatedAtMs < thresholdMs) return;
      try {
        await ctx.ddb.send(
          new UpdateCommand({
            TableName: ctx.deploymentsTableName,
            Key: { PK: row.PK, SK: "META" },
            UpdateExpression:
              "SET #status = :failed, updatedAt = :now, #reason = :reason REMOVE GSI2PK, GSI2SK",
            ConditionExpression: "#status = :deleting",
            ExpressionAttributeNames: {
              "#status": "status",
              "#reason": "failureReason",
            },
            ExpressionAttributeValues: {
              ":deleting": "DELETING",
              ":failed": "FAILED",
              ":now": new Date(nowMs).toISOString(),
              ":reason": `reconciler: stuck DELETING > ${Math.floor(thresholdMs / 60_000)} min, treating as FAILED to unblock Event TEARDOWN (#828)`,
            },
          }),
        );
        rescued += 1;
        console.warn("[generic-scoring] rescued stuck DELETING deployment", {
          PK: row.PK,
          staleForMs: nowMs - updatedAtMs,
        });
      } catch (err) {
        const code = (err as { name?: string })?.name ?? "";
        // CCF = 並行 MarkDeleted / MarkFailed が先に勝った。 次 tick で再評価されるのでこの tick は skip。
        if (code === "ConditionalCheckFailedException") return;
        console.warn("[generic-scoring] stuck-DELETING rescue failed", {
          PK: row.PK,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return rescued;
}

/**
 * Events table を scan して `DEPLOYING` / `TEARDOWN` 状態の Event について、
 * 子 deployment 集約 status を見て `READY` / `ARCHIVED` に遷移させる (#557 #539)。
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
        ProjectionExpression: "PK, tenantId, eventId, #status",
        ExpressionAttributeNames: { "#status": "status" },
        FilterExpression: "#status = :deploying OR #status = :teardown",
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":teardown": "TEARDOWN",
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
    }>;

    const nowMs = Date.parse(nowIso);
    await Promise.all(
      items.map(async (event) => {
        if (!event.tenantId || !event.eventId || !event.status || !event.PK) return;
        // narrow optional から required へ (= 以降 closure 内では string 確定)
        const eventStatus: string = event.status;
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

        try {
          await ctx.ddb.send(
            new UpdateCommand({
              TableName: ctx.eventsTableName,
              Key: { PK: event.PK, SK: "META" },
              UpdateExpression: "SET #status = :next, updatedAt = :now",
              // race 防止: 期待 current status と一致しているときのみ更新 (= operator が
              // 手動 archive / 再 deploy で先に動かしてたら CCF で skip)。
              ConditionExpression: "tenantId = :tenant AND #status = :current",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":tenant": event.tenantId,
                ":current": eventStatus,
                ":next": next,
                ":now": nowIso,
              },
            }),
          );
          console.log("[generic-scoring] Event status auto-transition", {
            eventId: event.eventId,
            from: eventStatus,
            to: next,
          });
        } catch (err) {
          const code = (err as { name?: string })?.name ?? "";
          if (code === "ConditionalCheckFailedException") return;
          console.warn("[generic-scoring] Event status update failed", {
            eventId: event.eventId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}
