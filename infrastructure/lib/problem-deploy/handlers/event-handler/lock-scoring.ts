import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { EventSharedResources } from "./shared.js";
import type { EventItem } from "./types.js";

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
 * - status とは独立な軸として `scoringLocked` flag を立てる (D1: 案 A、boolean orthogonal)
 * - audit: 誰がいつ lock したかを attribute に残す
 * - reversible: unlockScoring で false に戻せる
 *
 * 加点経路への影響 (本関数の外):
 * - HealthCheck Lambda が event の scoringLocked を check して probe / 加点 skip
 * - submit-flag handler が event の scoringLocked を check して `scoring_locked` outcome 返す
 */
export async function lockScoring(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  lockedBy: string,
  nowMs: number,
): Promise<LockScoringOutcome> {
  const now = new Date(nowMs).toISOString();

  try {
    const updateOut = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression:
          "SET scoringLocked = :t, scoringLockedAt = :now, scoringLockedBy = :who, updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#s = :ready OR #s = :ended) AND (attribute_not_exists(scoringLocked) OR scoringLocked = :f)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":t": true,
          ":f": false,
          ":now": now,
          ":who": lockedBy,
          ":tenantId": tenantId,
          ":ready": "READY",
          ":ended": "ENDED",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const item = updateOut.Attributes as Partial<EventItem> | undefined;
    if (!item) return { kind: "not_found" };
    return { kind: "ok", scoringLocked: true, scoringLockedAt: now };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return resolveLockFailure(shared, tenantId, eventId, true);
    }
    throw err;
  }
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

  try {
    const updateOut = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression:
          "REMOVE scoringLocked, scoringLockedAt, scoringLockedBy SET updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#s = :ready OR #s = :ended) AND scoringLocked = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":t": true,
          ":now": now,
          ":tenantId": tenantId,
          ":ready": "READY",
          ":ended": "ENDED",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const item = updateOut.Attributes as Partial<EventItem> | undefined;
    if (!item) return { kind: "not_found" };
    return { kind: "ok", scoringLocked: false };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return resolveLockFailure(shared, tenantId, eventId, false);
    }
    throw err;
  }
}

/**
 * Condition fail 時の理由を Get で確認して outcome を組み立てる。
 *   - 行不在 / tenant 不一致 → not_found
 *   - status が lockable でない → not_lockable
 *   - 既に target 状態 → already (idempotent)
 */
async function resolveLockFailure(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  targetLock: boolean,
): Promise<LockScoringOutcome> {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const probe = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
    }),
  );
  const item = probe.Item as Partial<EventItem> | undefined;
  if (!item || item.tenantId !== tenantId) return { kind: "not_found" };
  const status = typeof item.status === "string" ? item.status : "?";
  if (!LOCKABLE_STATUSES.has(status)) return { kind: "not_lockable", status };
  const current = item.scoringLocked === true;
  if (current === targetLock) return { kind: "already", scoringLocked: current };
  return { kind: "not_lockable", status };
}
