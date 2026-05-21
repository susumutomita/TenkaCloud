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
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数 (= 終了 N 分前から順位を隠す)。
   * 未指定なら既存値を保持、 0 で freeze 無効化、 1〜180 が有効範囲。
   */
  readonly scoreboardFreezeMinutes?: number;
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
      scoreboardFreezeMinutes?: number;
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
  const { startsAt, endsAt, scoreboardFreezeMinutes } = params;
  const validation = validateScheduleParams(params);
  if (validation) return validation;

  const currentEvent = await getCurrentSchedule(shared, eventId);
  if (!currentEvent || currentEvent.tenantId !== tenantId) return { kind: "not_found" };

  const effectiveStartsAt = startsAt ?? currentEvent.startsAt;
  const effectiveEndsAt = endsAt ?? currentEvent.endsAt;
  const effectiveOrder = validateScheduleOrder(effectiveStartsAt, effectiveEndsAt);
  if (effectiveOrder) return effectiveOrder;
  const update = buildScheduleUpdate(tenantId, params);
  const updatedEvent = await updateEventSchedule(shared, eventId, update);
  if (!updatedEvent) return { kind: "not_found" };

  // 紐づく deployment 行を全部引いて eventStartsAt / eventEndsAt を伝播。
  const updatedDeployments = await propagateSchedule(shared, tenantId, eventId, update);

  return {
    kind: "ok",
    startsAt,
    endsAt,
    ...(scoreboardFreezeMinutes !== undefined ? { scoreboardFreezeMinutes } : {}),
    updatedDeployments,
  };
}

function validateScheduleParams(
  params: SetEventScheduleParams,
): SetEventScheduleOutcome | undefined {
  const { startsAt, endsAt, scoreboardFreezeMinutes, nowMs } = params;
  if (startsAt === undefined && endsAt === undefined && scoreboardFreezeMinutes === undefined) {
    return { kind: "no_op" };
  }
  if (isPastScheduleTime(startsAt, nowMs)) return { kind: "past_starts_at", startsAt, nowMs };
  if (isPastScheduleTime(endsAt, nowMs)) return { kind: "past_ends_at", endsAt, nowMs };
  return validateScheduleOrder(startsAt, endsAt);
}

function isPastScheduleTime(value: string | undefined, nowMs: number): value is string {
  if (value === undefined) return false;
  const valueMs = new Date(value).getTime();
  return Number.isFinite(valueMs) && valueMs < nowMs - SCHEDULE_SLACK_MS;
}

function validateScheduleOrder(
  startsAt: string | undefined,
  endsAt: string | undefined,
): Extract<SetEventScheduleOutcome, { kind: "ends_before_starts" }> | undefined {
  if (startsAt === undefined || endsAt === undefined) return undefined;
  const startsAtMs = new Date(startsAt).getTime();
  const endsAtMs = new Date(endsAt).getTime();
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs > startsAtMs) {
    return undefined;
  }
  return { kind: "ends_before_starts", startsAt, endsAt };
}

async function getCurrentSchedule(
  shared: EventSharedResources,
  eventId: string,
): Promise<Pick<EventItem, "tenantId" | "startsAt" | "endsAt"> | undefined> {
  const currentOut = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
      ProjectionExpression: "tenantId, startsAt, endsAt",
    }),
  );
  return currentOut.Item as Pick<EventItem, "tenantId" | "startsAt" | "endsAt"> | undefined;
}

interface ScheduleUpdate {
  readonly eventExpression: string;
  readonly eventValues: Record<string, string | number>;
  readonly deploymentExpression: string;
  readonly deploymentValues: Record<string, string>;
}

function buildScheduleUpdate(tenantId: string, params: SetEventScheduleParams): ScheduleUpdate {
  const now = new Date(params.nowMs).toISOString();
  const eventParts = ["updatedAt = :now"];
  const deploymentParts = ["updatedAt = :now"];
  const eventValues: Record<string, string | number> = { ":now": now, ":tenantId": tenantId };
  const deploymentValues: Record<string, string> = { ":now": now, ":tenantId": tenantId };
  if (params.startsAt !== undefined) {
    eventParts.push("startsAt = :startsAt");
    deploymentParts.push("eventStartsAt = :s");
    eventValues[":startsAt"] = params.startsAt;
    deploymentValues[":s"] = params.startsAt;
  }
  if (params.endsAt !== undefined) {
    eventParts.push("endsAt = :endsAt");
    deploymentParts.push("eventEndsAt = :e");
    eventValues[":endsAt"] = params.endsAt;
    deploymentValues[":e"] = params.endsAt;
  }
  if (params.scoreboardFreezeMinutes !== undefined) {
    eventParts.push("scoreboardFreezeMinutes = :fz");
    eventValues[":fz"] = params.scoreboardFreezeMinutes;
  }
  return {
    eventExpression: `SET ${eventParts.join(", ")}`,
    eventValues,
    deploymentExpression: `SET ${deploymentParts.join(", ")}`,
    deploymentValues,
  };
}

async function updateEventSchedule(
  shared: EventSharedResources,
  eventId: string,
  update: ScheduleUpdate,
): Promise<Partial<EventItem> | undefined> {
  try {
    const out = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: update.eventExpression,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: update.eventValues,
        ReturnValues: "ALL_NEW",
      }),
    );
    return out.Attributes as Partial<EventItem> | undefined;
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return undefined;
    throw err;
  }
}

async function propagateSchedule(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  update: ScheduleUpdate,
): Promise<number> {
  const deployments = await queryDeploymentsByEvent(shared, tenantId, eventId, "PK");
  const targets = deployments
    .map((deployment) => deployment as Pick<DeploymentItem, "PK">)
    .filter((deployment) => typeof deployment.PK === "string");
  await Promise.all(targets.map((target) => updateDeploymentSchedule(shared, target, update)));
  return targets.length;
}

async function updateDeploymentSchedule(
  shared: EventSharedResources,
  target: Pick<DeploymentItem, "PK">,
  update: ScheduleUpdate,
): Promise<void> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.deploymentsTableName,
        Key: { PK: target.PK, SK: "META" },
        UpdateExpression: update.deploymentExpression,
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: update.deploymentValues,
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
    throw err;
  }
}
