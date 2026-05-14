import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { type EventSharedResources, queryDeploymentsByEvent } from "./shared.js";
import type { EventItem } from "./types.js";

/**
 * `setEventSchedule` の引数 (= startsAt / endsAt の組み合わせを 1 object で受ける)。
 * caller (handler/index.ts) が `startNow: true` を server now に解決した後に渡す形。
 */
export interface SetEventScheduleParams {
  /** 競技開始時刻 (ISO8601 Z)。未指定なら既存値を保持 */
  readonly startsAt?: string;
  /** 競技終了予約時刻 (ISO8601 Z、#536)。未指定なら既存値を保持 */
  readonly endsAt?: string;
  /** 現在時刻 (ms)。validation の比較基準 */
  readonly nowMs: number;
}

/**
 * `setEventSchedule` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `past_starts_at`: 指定 startsAt が `now - SLACK_MS` 以前 → 400 相当 (#537)
 * - `past_ends_at`: 指定 endsAt が `now - SLACK_MS` 以前 → 400 相当 (#536)
 * - `ends_before_starts`: 指定 endsAt <= startsAt → 400 相当 (#536)
 * - `no_op`: 何も指定なし (= zod 通過後ありえない、defense-in-depth)
 * - `ok`: 更新後の startsAt / endsAt + 影響を受けた deployment 数
 */
export type SetEventScheduleOutcome =
  | { kind: "not_found" }
  | { kind: "past_starts_at"; startsAt: string; nowMs: number }
  | { kind: "past_ends_at"; endsAt: string; nowMs: number }
  | { kind: "ends_before_starts"; startsAt: string; endsAt: string }
  | { kind: "no_op" }
  | {
      kind: "ok";
      startsAt?: string;
      endsAt?: string;
      updatedDeployments: number;
    };

/**
 * 過去日時 reject の slack (= clock skew tolerance、#537 #536)。これより過去の startsAt /
 * endsAt は backend 側で reject する。
 *
 * 60s = LB / Lambda の clock drift 経験上の上限。これより緩いと typo 起因の誤入力を
 * 通してしまうし、これより厳しいと真っ当な「ちょっと前の時刻」も弾いてしまう。
 */
const SCHEDULE_SLACK_MS = 60_000;

/**
 * Event の `startsAt` / `endsAt` を更新し、紐づく全 deployment 行にも denormalize する。
 *
 * HealthCheckLambda は deployment 行の `eventStartsAt` / `eventEndsAt` を見て probe / 採点
 * gate するため、Event 単独更新では足りない。event-handler Lambda は Deployments table に
 * R/W 権限を持つので CDK 改修不要。
 *
 * caller (handler/index.ts) は zod validate 済を前提。validation:
 *   - past_starts_at: startsAt < now - SLACK
 *   - past_ends_at:   endsAt   < now - SLACK
 *   - ends_before_starts: effective endsAt <= effective startsAt
 *
 * tenant 跨ぎ参照防止: Event 行の tenantId が引数 `tenantId` と一致しない場合は `not_found`。
 */
export async function setEventSchedule(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  params: SetEventScheduleParams,
): Promise<SetEventScheduleOutcome> {
  const { startsAt, endsAt, nowMs } = params;
  // zod 通過済なので両方 undefined にはならない想定だが、defense-in-depth。
  if (startsAt === undefined && endsAt === undefined) {
    return { kind: "no_op" };
  }

  // #537: 過去 startsAt reject。「即座に開始」は handler で server now に解決済なので、
  // ここに到達する startsAt は operator 入力 (= 任意時刻)。
  if (startsAt !== undefined) {
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && startsAtMs < nowMs - SCHEDULE_SLACK_MS) {
      return { kind: "past_starts_at", startsAt, nowMs };
    }
  }
  // #536: 過去 endsAt reject。「Event を終了」 button は別 endpoint
  // (POST /events/:id/end) で server now を書く経路があるので、本 schedule API には
  // 未来の endsAt のみが来る想定。
  if (endsAt !== undefined) {
    const endsAtMs = new Date(endsAt).getTime();
    if (Number.isFinite(endsAtMs) && endsAtMs < nowMs - SCHEDULE_SLACK_MS) {
      return { kind: "past_ends_at", endsAt, nowMs };
    }
  }
  // #536: 両方指定時に endsAt <= startsAt を弾く (= 競技時間 0 や負を防ぐ)。
  if (startsAt !== undefined && endsAt !== undefined) {
    const startsAtMs = new Date(startsAt).getTime();
    const endsAtMs = new Date(endsAt).getTime();
    if (Number.isFinite(startsAtMs) && Number.isFinite(endsAtMs) && endsAtMs <= startsAtMs) {
      return { kind: "ends_before_starts", startsAt, endsAt };
    }
  }

  const currentOut = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
      ProjectionExpression: "tenantId, startsAt, endsAt",
    }),
  );
  const currentEvent = currentOut.Item as Pick<EventItem, "tenantId" | "startsAt" | "endsAt">;
  if (!currentEvent || currentEvent.tenantId !== tenantId) return { kind: "not_found" };

  const effectiveStartsAt = startsAt ?? currentEvent.startsAt;
  const effectiveEndsAt = endsAt ?? currentEvent.endsAt;
  if (effectiveStartsAt !== undefined && effectiveEndsAt !== undefined) {
    const startsAtMs = new Date(effectiveStartsAt).getTime();
    const endsAtMs = new Date(effectiveEndsAt).getTime();
    if (Number.isFinite(startsAtMs) && Number.isFinite(endsAtMs) && endsAtMs <= startsAtMs) {
      return {
        kind: "ends_before_starts",
        startsAt: effectiveStartsAt,
        endsAt: effectiveEndsAt,
      };
    }
  }

  // dynamic UpdateExpression: 指定 field のみ更新 (= 既存値を保持)。
  // ExpressionAttributeNames で "endsAt" は予約語衝突なしだが symmetry で `#` 付に。
  const setParts: string[] = ["updatedAt = :now"];
  const exprValues: Record<string, string> = {
    ":now": new Date(nowMs).toISOString(),
    ":tenantId": tenantId,
  };
  if (startsAt !== undefined) {
    setParts.push("startsAt = :startsAt");
    exprValues[":startsAt"] = startsAt;
  }
  if (endsAt !== undefined) {
    setParts.push("endsAt = :endsAt");
    exprValues[":endsAt"] = endsAt;
  }
  const updateExpression = `SET ${setParts.join(", ")}`;

  let updatedEvent: Partial<EventItem> | undefined;
  try {
    const updateOut = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: updateExpression,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );
    updatedEvent = updateOut.Attributes as Partial<EventItem> | undefined;
  } catch (err) {
    // ConditionalCheckFailedException = 行不在 or tenant 不一致 → not_found
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return { kind: "not_found" };
    }
    throw err;
  }
  if (!updatedEvent) return { kind: "not_found" };

  // 紐づく deployment 行を全部引いて eventStartsAt / eventEndsAt を伝播。
  const deploymentsOut = await queryDeploymentsByEvent(shared, tenantId, eventId, "PK");
  const targets = deploymentsOut
    .map((d) => d as Pick<DeploymentItem, "PK">)
    .filter((d) => typeof d.PK === "string");

  // deployment 側も dynamic UpdateExpression — startsAt のみ / endsAt のみ / 両方 を対応
  const depSetParts: string[] = ["updatedAt = :now"];
  const depExprValues: Record<string, string> = { ":now": exprValues[":now"] ?? "" };
  if (startsAt !== undefined) {
    depSetParts.push("eventStartsAt = :s");
    depExprValues[":s"] = startsAt;
  }
  if (endsAt !== undefined) {
    depSetParts.push("eventEndsAt = :e");
    depExprValues[":e"] = endsAt;
  }
  const depUpdateExpression = `SET ${depSetParts.join(", ")}`;

  // Promise.all で並列 update。各 row は冪等な field update。
  await Promise.all(
    targets.map((d) =>
      shared.ddb.send(
        new UpdateCommand({
          TableName: shared.deploymentsTableName,
          Key: { PK: d.PK, SK: "META" },
          UpdateExpression: depUpdateExpression,
          ExpressionAttributeValues: depExprValues,
        }),
      ),
    ),
  );

  return { kind: "ok", startsAt, endsAt, updatedDeployments: targets.length };
}
