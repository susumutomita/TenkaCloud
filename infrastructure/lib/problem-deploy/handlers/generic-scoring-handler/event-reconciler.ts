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

    await Promise.all(
      items.map(async (event) => {
        if (!event.tenantId || !event.eventId || !event.status || !event.PK) return;
        // 子 deployments を GSI1 (TENANT#) で query → 同 event のものに in-memory filter。
        const depsOut = await ctx.ddb.send(
          new QueryCommand({
            TableName: ctx.deploymentsTableName,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :pk",
            FilterExpression: "eventId = :ev",
            ProjectionExpression: "#status",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pk": `TENANT#${event.tenantId}`,
              ":ev": event.eventId,
            },
          }),
        );
        const depStatuses = (depsOut.Items ?? [])
          .map((d) => String((d as { status?: string }).status ?? ""))
          .filter((s) => s.length > 0);
        const next = resolveEventStatusTransition(event.status, depStatuses);
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
                ":current": event.status,
                ":next": next,
                ":now": nowIso,
              },
            }),
          );
          console.log("[generic-scoring] Event status auto-transition", {
            eventId: event.eventId,
            from: event.status,
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
