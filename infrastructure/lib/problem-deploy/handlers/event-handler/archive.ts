import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { EventSharedResources } from "./shared.js";
import type { EventItem } from "./types.js";

/**
 * `archiveEvent` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `not_archivable`: 進行中 (DEPLOYING / READY) や ARCHIVED 重複 → 409 相当
 * - `ok`: ARCHIVED 遷移完了
 */
export type ArchiveEventOutcome =
  | { kind: "not_found" }
  | { kind: "not_archivable"; status: string }
  | { kind: "ok"; archivedAt: string };

/**
 * Event を `ARCHIVED` 状態に遷移させ、EventList のデフォルト view から外す soft delete。
 *
 * Issue #493: 完了 event を一覧から消す手段が無い問題への対応。Team 行 / Deployments の
 * 物理削除はしない (= TTL に任せる)。これは:
 *   - Bulk Teardown 済の event は deployment 行が DELETED 状態で残るが、TTL で消える
 *   - Team 行も TTL を持つので放っておけば消える
 *   - 物理削除を別 op にすると確認 modal が増えて UX 重くなる
 *
 * 状態遷移は `ConditionExpression` で atomic に check (= 並列操作のレース防止)。
 */
export async function archiveEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<ArchiveEventOutcome> {
  const now = new Date(nowMs).toISOString();

  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET #s = :archived, archivedAt = :now, updatedAt = :now",
        // tenant 跨ぎ防止 + 許可状態のみに限定 (DRAFT / ENDED / TEARDOWN)
        ConditionExpression: "tenantId = :tenantId AND #s IN (:draft, :ended, :teardown)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":archived": "ARCHIVED",
          ":draft": "DRAFT",
          ":ended": "ENDED",
          ":teardown": "TEARDOWN",
          ":now": now,
          ":tenantId": tenantId,
        },
      }),
    );
    return { kind: "ok", archivedAt: now };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      // 行不在 / tenant 不一致 / 許可外状態のいずれか → probe で区別
      const probe = await shared.ddb.send(
        new GetCommand({
          TableName: shared.eventsTableName,
          Key: { PK: `EVENT#${eventId}`, SK: "META" },
        }),
      );
      const item = probe.Item as Partial<EventItem> | undefined;
      if (!item || item.tenantId !== tenantId) return { kind: "not_found" };
      const status = typeof item.status === "string" ? item.status : "?";
      return { kind: "not_archivable", status };
    }
    throw err;
  }
}
