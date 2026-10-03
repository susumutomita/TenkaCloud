import type { EventRecord } from "../../control-data/events-repository.js";
import { type EventSharedResources, resolveEventRepositories } from "./shared.js";

/**
 * #558 `lockScoring` / `unlockScoring` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404
 * - `not_lockable`: status が DRAFT / DEPLOYING / TEARDOWN / ARCHIVED (= まだ採点無し or 既に teardown) → 409
 * - `already`: lock を true→true / false→false に切り替えようとした (= no-op、idempotent OK で 200)
 * - `ok`: 切替完了
 */
export type LockScoringOutcome =
  | { kind: "not_found" }
  | { kind: "not_lockable"; status: string }
  | { kind: "already"; scoringLocked: boolean }
  | { kind: "ok"; scoringLocked: boolean; scoringLockedAt?: string };

const LOCKABLE_STATUSES = new Set(["READY", "ENDED"]);

/**
 * #558: Event の採点 lock を true に切り替える。
 *
 * 設計判断:
 * - `READY` / `ENDED` の event のみ lock 可能 (= 採点が走りうる状態)。DRAFT / DEPLOYING /
 *   TEARDOWN / ARCHIVED は加点経路自体が無いので lock 無意味
 * - status とは独立した boolean の `scoringLocked` flag を立てる
 * - audit: 誰がいつ lock したかを attribute に残す
 * - reversible: unlockScoring で false に戻せる
 *
 * 加点経路への影響 (本関数の外):
 * - HealthCheck Lambda が event の scoringLocked を check して probe / 加点 skip
 * - submit-flag handler が event の scoringLocked を check して `scoring_locked` outcome 返す
 *
 * [#2437 Phase A2] 条件付き書き込みは repository seam の
 * `lockScoring(tenantId, eventId, by, at)` に移設。 CCF catch + probe Get の分岐は
 * `EventMutationOutcome` union の分岐に置き換え (HTTP ステータス対応は不変)。
 */
export async function lockScoring(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  lockedBy: string,
  nowMs: number,
): Promise<LockScoringOutcome> {
  const now = new Date(nowMs).toISOString();

  const repositories = await resolveEventRepositories(shared);
  const result = await repositories.events.lockScoring(tenantId, eventId, lockedBy, now);
  // updated: 成功判定は outcome 自身が担う (post-image 無しの degenerate 応答は
  // repository 層が not_found に畳み済み)。
  if (result.outcome === "updated") {
    return { kind: "ok", scoringLocked: true, scoringLockedAt: now };
  }
  if (result.outcome === "not_found") return { kind: "not_found" };
  return classifyLockConflict(result.event, true);
}

/**
 * #558: Event の採点 lock を false に切り替える (unlock)。
 *
 * idempotent: 既に unlocked なら `already` outcome を返す (= 200 OK で副作用無し)。
 * status check は lockScoring と同じ (READY / ENDED のみ)。
 */
export async function unlockScoring(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<LockScoringOutcome> {
  const now = new Date(nowMs).toISOString();

  const repositories = await resolveEventRepositories(shared);
  const result = await repositories.events.unlockScoring(tenantId, eventId, now);
  if (result.outcome === "updated") {
    return { kind: "ok", scoringLocked: false };
  }
  if (result.outcome === "not_found") return { kind: "not_found" };
  return classifyLockConflict(result.event, false);
}

/**
 * 条件不成立 (conflict) の理由を probe 済み event から組み立てる。
 *   - probe 結果無し → not_found (defensive、seam は conflict に必ず event を同梱する)
 *   - status が lockable でない → not_lockable
 *   - 既に target 状態 → already (idempotent)
 */
function classifyLockConflict(
  event: EventRecord | undefined,
  targetLock: boolean,
): LockScoringOutcome {
  if (!event) return { kind: "not_found" };
  const status = typeof event.status === "string" ? event.status : "?";
  if (!LOCKABLE_STATUSES.has(status)) return { kind: "not_lockable", status };
  const current = event.scoringLocked === true;
  if (current === targetLock) return { kind: "already", scoringLocked: current };
  return { kind: "not_lockable", status };
}
