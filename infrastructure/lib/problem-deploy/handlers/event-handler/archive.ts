import { type EventSharedResources, resolveEventRepositories } from "./shared.js";

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
 * 状態遷移の atomic check (= 並列操作のレース防止) は repository seam の
 * `archiveEvent(tenantId, eventId, at)` が担う。 [#2437 Phase A2] CCF catch + probe Get
 * の分岐は `EventMutationOutcome` union の分岐に置き換え (HTTP ステータス対応は不変)。
 */
export async function archiveEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<ArchiveEventOutcome> {
  const now = new Date(nowMs).toISOString();

  const repositories = await resolveEventRepositories(shared);
  const result = await repositories.events.archiveEvent(tenantId, eventId, now);
  if (result.outcome === "updated") return { kind: "ok", archivedAt: now };
  if (result.outcome === "not_found") return { kind: "not_found" };
  return {
    kind: "not_archivable",
    status: typeof result.event?.status === "string" ? result.event.status : "?",
  };
}
