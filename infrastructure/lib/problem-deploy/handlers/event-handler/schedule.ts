import type {
  DeploymentSchedulePatch,
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import type { EventSchedulePatch } from "../../control-data/events-repository.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveEventRepositories,
} from "./shared.js";

/**
 * `setEventSchedule` の引数 (= startsAt / endsAt の組み合わせを 1 object で受ける)。
 * caller (handler/index.ts) が `startNow: true` を server now に解決した後に渡す形。
 */
export interface SetEventScheduleParams {
  /** 競技開始時刻 (ISO8601 Z)。未指定なら既存値を保持 */
  readonly startsAt?: string;
  /** 競技終了予約時刻 (ISO8601 Z、#536)。未指定なら既存値を保持 */
  readonly endsAt?: string;
  /** 自動撤去予定時刻 (ISO8601 Z)。未指定なら既存値を保持。teardownAt >= 実効 endsAt 必須 */
  readonly teardownAt?: string;
  /**
   * 自動デプロイ予定時刻 (ISO8601 Z)。未指定なら既存値を保持。
   * deployAt <= 実効 endsAt 必須 (deploy → 採点 → 終了 の時系列を保つ)。
   */
  readonly deployAt?: string;
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
 * - `past_teardown_at`: 指定 teardownAt が `now - SLACK_MS` 以前 → 400 相当
 * - `teardown_before_ends`: 実効 teardownAt < 実効 endsAt → 400 相当 (always-ends)
 * - `past_deploy_at`: 指定 deployAt が `now - SLACK_MS` 以前 → 400 相当
 * - `deploy_after_ends`: 実効 deployAt > 実効 endsAt → 400 相当 (deploy は終了より前)
 * - `no_op`: 何も指定なし (= zod 通過後ありえない、defense-in-depth)
 * - `ok`: 更新後の startsAt / endsAt / teardownAt / deployAt + 影響を受けた deployment 数
 */
export type SetEventScheduleOutcome =
  | { kind: "not_found" }
  | { kind: "past_starts_at"; startsAt: string; nowMs: number }
  | { kind: "past_ends_at"; endsAt: string; nowMs: number }
  | { kind: "ends_before_starts"; startsAt: string; endsAt: string }
  | { kind: "past_teardown_at"; teardownAt: string; nowMs: number }
  | { kind: "teardown_before_ends"; teardownAt: string; endsAt: string }
  | { kind: "past_deploy_at"; deployAt: string; nowMs: number }
  | { kind: "deploy_after_ends"; deployAt: string; endsAt: string }
  | { kind: "no_op" }
  | {
      kind: "ok";
      startsAt?: string;
      endsAt?: string;
      teardownAt?: string;
      deployAt?: string;
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
  const { startsAt, endsAt, teardownAt, deployAt, scoreboardFreezeMinutes } = params;
  const validation = validateScheduleParams(params);
  if (validation) return validation;

  // Event 行の read / write は同じ repository seam を使う。 turso backend
  // (`CONTROL_DATA_BACKEND=turso`) でも効くよう runtime resolver 経由 (default backend は
  // byte 互換)。 getEvent は tenant scope + 404 判定を内包する (= 従来の Get +
  // `tenantId` 手動照合と等価。 旧実装の ProjectionExpression 絞り込みは A1 で撤去済)。
  const repositories = await resolveEventRepositories(shared);
  const currentEvent = await repositories.events.getEvent(tenantId, eventId);
  if (!currentEvent) return { kind: "not_found" };

  const effectiveStartsAt = startsAt ?? currentEvent.startsAt;
  const effectiveEndsAt = endsAt ?? currentEvent.endsAt;
  const effectiveOrder = validateScheduleOrder(effectiveStartsAt, effectiveEndsAt);
  if (effectiveOrder) return effectiveOrder;
  // teardownAt >= 実効 endsAt (採点 gate を閉じてから撤去する always-ends 不変条件)。
  const effectiveTeardownAt = teardownAt ?? currentEvent.teardownAt;
  const teardownOrder = validateTeardownOrder(effectiveTeardownAt, effectiveEndsAt);
  if (teardownOrder) return teardownOrder;
  // deployAt <= 実効 endsAt (deploy → 採点 → 終了 の時系列を保つ)。
  const effectiveDeployAt = deployAt ?? currentEvent.deployAt;
  const deployOrder = validateDeployOrder(effectiveDeployAt, effectiveEndsAt);
  if (deployOrder) return deployOrder;
  // [#2437 Phase A2] Event 行の動的 SET + tenant 条件は repository seam の
  // `updateSchedule(tenantId, eventId, patch, at)` に移設。 条件は tenant 照合のみなので
  // union は updated / not_found の 2 値に畳まれる (HTTP ステータス対応は不変)。
  const now = new Date(params.nowMs).toISOString();
  const patch = buildSchedulePatch(params);
  const result = await repositories.events.updateSchedule(tenantId, eventId, patch, now);
  if (result.outcome !== "updated") return { kind: "not_found" };

  // 紐づく deployment 行を全部引いて eventStartsAt / eventEndsAt を伝播。
  // teardownAt / deployAt は event-level のみ (reconciler が event 行から読む) なので denormalize しない。
  const updatedDeployments = await propagateSchedule(
    shared,
    tenantId,
    eventId,
    { startsAt: params.startsAt, endsAt: params.endsAt },
    now,
  );

  return {
    kind: "ok",
    startsAt,
    endsAt,
    ...(teardownAt !== undefined ? { teardownAt } : {}),
    ...(deployAt !== undefined ? { deployAt } : {}),
    ...(scoreboardFreezeMinutes !== undefined ? { scoreboardFreezeMinutes } : {}),
    updatedDeployments,
  };
}

function validateScheduleParams(
  params: SetEventScheduleParams,
): SetEventScheduleOutcome | undefined {
  const { startsAt, endsAt, teardownAt, deployAt, scoreboardFreezeMinutes, nowMs } = params;
  if (
    startsAt === undefined &&
    endsAt === undefined &&
    teardownAt === undefined &&
    deployAt === undefined &&
    scoreboardFreezeMinutes === undefined
  ) {
    return { kind: "no_op" };
  }
  if (isPastScheduleTime(startsAt, nowMs)) return { kind: "past_starts_at", startsAt, nowMs };
  if (isPastScheduleTime(endsAt, nowMs)) return { kind: "past_ends_at", endsAt, nowMs };
  if (isPastScheduleTime(teardownAt, nowMs)) return { kind: "past_teardown_at", teardownAt, nowMs };
  if (isPastScheduleTime(deployAt, nowMs)) return { kind: "past_deploy_at", deployAt, nowMs };
  const order = validateScheduleOrder(startsAt, endsAt);
  if (order) return order;
  // teardownAt + endsAt が同一 request にあり teardownAt < endsAt なら pre-fetch で reject
  // (= ends_before_starts と同じく DDB 不触)。 teardownAt 単独 vs 既存 endsAt は post-fetch で判定。
  const teardownOrder = validateTeardownOrder(teardownAt, endsAt);
  if (teardownOrder) return teardownOrder;
  // deployAt + endsAt が同一 request にあり deployAt > endsAt なら pre-fetch で reject。
  // deployAt 単独 vs 既存 endsAt は post-fetch で判定 (= teardownAt と対称)。
  return validateDeployOrder(deployAt, endsAt);
}

/**
 * 実効 teardownAt が 実効 endsAt より前なら `teardown_before_ends`。
 * どちらかが未設定なら制約なし (= undefined)。 endsAt 未設定の event は無期限なので
 * teardownAt 単独設定も許容する (= 「いつか撤去」 を予約できる)。
 */
function validateTeardownOrder(
  teardownAt: string | undefined,
  endsAt: string | undefined,
): Extract<SetEventScheduleOutcome, { kind: "teardown_before_ends" }> | undefined {
  if (teardownAt === undefined || endsAt === undefined) return undefined;
  const teardownAtMs = new Date(teardownAt).getTime();
  const endsAtMs = new Date(endsAt).getTime();
  if (!Number.isFinite(teardownAtMs) || !Number.isFinite(endsAtMs) || teardownAtMs >= endsAtMs) {
    return undefined;
  }
  return { kind: "teardown_before_ends", teardownAt, endsAt };
}

/**
 * 実効 deployAt が 実効 endsAt より後なら `deploy_after_ends`。
 * どちらかが未設定なら制約なし (= undefined)。 endsAt 未設定の event は無期限なので
 * deployAt 単独設定も許容する (= 「いつか deploy」 を予約できる)。 teardownOrder の鏡像で、
 * deploy は採点終了より後ろに置けないという時系列制約を表す。
 */
function validateDeployOrder(
  deployAt: string | undefined,
  endsAt: string | undefined,
): Extract<SetEventScheduleOutcome, { kind: "deploy_after_ends" }> | undefined {
  if (deployAt === undefined || endsAt === undefined) return undefined;
  const deployAtMs = new Date(deployAt).getTime();
  const endsAtMs = new Date(endsAt).getTime();
  if (!Number.isFinite(deployAtMs) || !Number.isFinite(endsAtMs) || deployAtMs <= endsAtMs) {
    return undefined;
  }
  return { kind: "deploy_after_ends", deployAt, endsAt };
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

/**
 * Event 行へ書く field だけを patch に写す (Event 側の式構築は repository seam)。
 * teardownAt / deployAt は event 行のみ
 * (reconciler が event から読む) — deployment 非伝播。 両 backend とも
 * `!== undefined` の field だけを書くので、 undefined のままの pick で挙動は同一。
 */
function buildSchedulePatch(params: SetEventScheduleParams): EventSchedulePatch {
  return {
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    teardownAt: params.teardownAt,
    deployAt: params.deployAt,
    scoreboardFreezeMinutes: params.scoreboardFreezeMinutes,
  };
}

/**
 * [Issue #2441 / Phase B2] `applySchedulePatch` builds the identical dynamic SET
 * expression (`eventStartsAt` / `eventEndsAt` appended only when defined)
 * verbatim inside the seam and folds the CCF into a `not_found` outcome instead
 * of throwing — the pre-seam catch also silently skipped on CCF (a row that
 * changed tenant or was deleted mid-propagation), so discarding the outcome
 * here reproduces that no-op.
 */
async function propagateSchedule(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  patch: DeploymentSchedulePatch,
  now: string,
): Promise<number> {
  const repo: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(shared);
  const targetJobIds = await repo.listDeploymentKeysByEvent(tenantId, eventId);
  await Promise.all(
    targetJobIds.map((jobId) => repo.applySchedulePatch(jobId, tenantId, patch, now)),
  );
  return targetJobIds.length;
}
