import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  type EventSharedResources,
  queryDeploymentsByEvent,
  resolveEventsRepository,
} from "./shared.js";
import type { EventItem } from "./types.js";

/**
 * `endEvent` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `not_endable`: status が END に遷移可能でない (DRAFT / DEPLOYING / TEARDOWN /
 *    ARCHIVED / ENDED) → 409 相当。READY のみ許可。
 * - `ok`: 終了完了。endsAt と影響を受けた deployment 数を返す。
 */
export type EndEventOutcome =
  | { kind: "not_found" }
  | { kind: "not_endable"; status: string }
  | { kind: "ok"; endsAt: string; updatedDeployments: number };

/**
 * Event を `ENDED` 状態にし、紐づく全 deployment 行に `eventEndsAt` を denormalize する。
 *
 * HealthCheckLambda は deployment 行の `eventEndsAt` を見て probe / 採点 gate を切る
 * (now >= eventEndsAt なら skip)。Bulk Teardown 待たずに採点を停めるための path
 * (Issue #494)。Event 単独更新では足りないので schedule.ts と同じ denormalize 戦略。
 *
 * `READY` 状態のみ「終了」可能。
 *   - `DRAFT` / `DEPLOYING`: まだ動いていないので無意味
 *   - `TEARDOWN` / `ARCHIVED`: 既に teardown 済 → 終了は redundant
 *   - `ENDED`: 二重操作防止
 *
 * Issue #1095: ENDED 遷移と同時に `scoringLocked = true` も atomic に立てる。
 * 旧設計では scoringLocked は status と orthogonal な軸として保持していたが、
 * 「event 終了したのに 採点中 badge のまま」 という UX bug が出ていた。 ENDED は
 * 採点を継続する意味が無いので auto-lock を default にする。 READY 中の表彰
 * フェーズ用 manual lock (= lockEventScoring) は別経路で残るので柔軟性は保たれる。
 */
export async function endEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<EndEventOutcome> {
  const now = new Date(nowMs).toISOString();

  let updatedEvent: Partial<EventItem> | undefined;
  try {
    const updateOut = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        // #1095: ENDED 遷移と同時に scoringLocked / scoringLockedAt / scoringLockedBy を
        //        立てる (= 採点 gate 自動 lock)。 既に手動 lock 済 (scoringLocked=true) の
        //        event を ENDED にする場合は ConditionExpression が ready のみ許可なので
        //        通らず、 副作用なし。
        UpdateExpression:
          "SET #s = :ended, endsAt = :now, updatedAt = :now, scoringLocked = :true, scoringLockedAt = :now, scoringLockedBy = :system",
        // tenant 跨ぎ防止 + status=READY のみ許可
        ConditionExpression: "tenantId = :tenantId AND #s = :ready",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":ended": "ENDED",
          ":ready": "READY",
          ":now": now,
          ":tenantId": tenantId,
          ":true": true,
          ":system": "system:end-event",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    updatedEvent = updateOut.Attributes as Partial<EventItem> | undefined;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      // tenant 不一致 / 行不在 / status != READY のいずれか。区別するため seam で確認。
      // getEvent は tenant 不一致 / 不在をどちらも undefined に畳む (= 従来の
      // `!item || item.tenantId !== tenantId` を repository 内へ移設)。
      const event = await resolveEventsRepository(shared).getEvent(tenantId, eventId);
      if (!event) return { kind: "not_found" };
      return {
        kind: "not_endable",
        status: typeof event.status === "string" ? event.status : "?",
      };
    }
    throw err;
  }
  if (!updatedEvent) return { kind: "not_found" };

  const deploymentsOut = await queryDeploymentsByEvent(shared, tenantId, eventId, "PK");
  const targets = deploymentsOut
    .map((d) => d as Pick<DeploymentItem, "PK">)
    .filter((d) => typeof d.PK === "string");

  // #872: tenantId 一致を atomic に強制 (= queryDeploymentsByEvent が GSI1=TENANT#... で
  // 引いているので transitively 安全だが、 write レベルで明示する defense-in-depth)。
  await Promise.all(
    targets.map((d) =>
      shared.ddb
        .send(
          new UpdateCommand({
            TableName: shared.deploymentsTableName,
            Key: { PK: d.PK, SK: "META" },
            UpdateExpression: "SET eventEndsAt = :e, updatedAt = :now",
            ConditionExpression: "tenantId = :tenantId",
            ExpressionAttributeValues: { ":e": now, ":now": now, ":tenantId": tenantId },
          }),
        )
        .catch((err: unknown) => {
          // CCF = item が消えた / tenant 不一致 → idempotent な denormalize なので skip。
          if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
          throw err;
        }),
    ),
  );

  return { kind: "ok", endsAt: now, updatedDeployments: targets.length };
}
