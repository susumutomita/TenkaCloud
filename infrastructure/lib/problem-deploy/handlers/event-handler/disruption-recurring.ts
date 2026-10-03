/**
 * recurring disruption の一覧 / 早期解除 (operator 用)。
 *
 * Slice 1 で recurring fire は `rate(N minutes)` schedule + EndDate により maxFires 回ぶんで自動停止する
 * (= 必ず終わる)。 本 module はそれを **早期に止める** / **今動いている定期障害を見る** ための薄い層:
 *
 *   - list:   `EVENT#{eventId}` 配下の `RECUR#{requestId}` registry 行を引き、 未 cancel かつ endsAt 未到達
 *             のものだけ返す (= 自動停止後は自然に一覧から落ちる)。
 *   - cancel: registry 行の affectedTeamIds から per-team の `tc-recur-{requestId}-{teamId}` schedule 名を
 *             復元し DeleteSchedule。 EndDate 到達で既に自動削除済 (ResourceNotFound) は無視 (= 冪等)。
 *             最後に registry 行へ `cancelledAt` を刻む (= 一覧から外す + 監査)。
 *
 * schedule 作成は executor (operator account) が行うが、 削除は同一アカウント/region の event-handler から
 * 直接できる (= 名前が決定的なので EventBridge 往復不要)。 IAM は event-api-lambda に scheduler:DeleteSchedule
 * (tc-recur-* に scope) を 1 つ足すだけ。
 */

import { DeleteScheduleCommand, ResourceNotFoundException } from "@aws-sdk/client-scheduler";
import type { DisruptionRecurringRecord } from "../../control-data/types.js";
import { recurringScheduleNameOf } from "../disruption-executor-handler/schedule-revert.js";
import type { DisruptionFireInput } from "./disruption-types.js";
import { type EventSharedResources, resolveDisruptionsRepository } from "./shared.js";

/** ミリ秒 / 分。 `intervalMinutes` を epoch ms 換算するのに使う。 */
const MS_PER_MINUTE = 60_000;

export interface ActiveRecurringRow {
  readonly requestId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly scope: string;
  readonly affectedTeamIds: readonly string[];
  readonly intervalMinutes: number;
  readonly maxFires: number;
  /** maxFires 回ぶん経過して自動停止する時刻 (ISO8601)。 これを過ぎた行は一覧に出さない。 */
  readonly endsAt: string;
}

export interface ListRecurringResponse {
  readonly items: readonly ActiveRecurringRow[];
}

export type CancelRecurringOutcome = "cancelled" | "not_found";

/**
 * recurring fire のとき registry 行 (`EVENT#{eventId}` / `RECUR#{requestId}`) を書く。
 * 一覧 / 早期解除の索引であり、 affectedTeamIds から cancel 時の per-team schedule 名を復元できる。 EndDate
 * と同じ endsAt を持たせ、 自動停止後は一覧から自然に落ちる。 idempotency claim (REQUEST#) が dup を先に
 * 弾くので 1 度だけ書かれる (= attribute_not_exists(SK) は防御)。 非 recurring は no-op。
 */
export async function writeRecurringRegistry(
  shared: EventSharedResources,
  input: DisruptionFireInput,
  affectedTeamIds: readonly string[],
  firedAt: string,
  expiresAt: number,
): Promise<void> {
  if (!input.recurrence) return;
  const endsAt = new Date(
    input.nowMs + input.recurrence.intervalMinutes * input.recurrence.maxFires * MS_PER_MINUTE,
  ).toISOString();
  const repository = await resolveDisruptionsRepository(shared);
  await repository.putRecurringRegistry({
    requestId: input.requestId,
    tenantId: input.tenantId,
    eventId: input.eventId,
    problemId: input.problemId,
    disruptionId: input.disruptionId,
    firedBy: input.firedBy,
    firedAt,
    scope: input.scope,
    affectedTeamIds,
    intervalMinutes: input.recurrence.intervalMinutes,
    maxFires: input.recurrence.maxFires,
    endsAt,
    expiresAt,
  });
}

function toActiveRow(record: DisruptionRecurringRecord): ActiveRecurringRow {
  return {
    requestId: record.requestId,
    problemId: record.problemId,
    disruptionId: record.disruptionId,
    firedBy: record.firedBy,
    firedAt: record.firedAt,
    scope: record.scope,
    affectedTeamIds: record.affectedTeamIds,
    intervalMinutes: record.intervalMinutes,
    maxFires: record.maxFires,
    endsAt: record.endsAt,
  };
}

/**
 * event の RECUR# registry 行のうち、 まだ動いている (未 cancel + endsAt > now) ものを返す。
 * route 側 `requireEventOwnership` に加え、 service でも `tenantId` で scope する
 * (= 多層防御。 INVARIANT_TENANT_ISOLATION / Issue #997)。
 *
 * [Issue #2442 / Phase C3] DDB アクセスは repository seam に移設。「未 cancel + endsAt 未到達」の
 * filter は業務ロジックとしてここに残す。
 */
export async function listActiveRecurring(
  shared: EventSharedResources,
  eventId: string,
  tenantId: string,
  nowMs: number,
): Promise<ListRecurringResponse> {
  const repository = await resolveDisruptionsRepository(shared);
  const rows = await repository.listRecurringByEvent(eventId, tenantId);
  const now = new Date(nowMs).toISOString();
  const items = rows.filter((r) => !r.cancelledAt && r.endsAt > now).map(toActiveRow);
  return { items };
}

async function deleteScheduleIfExists(shared: EventSharedResources, name: string): Promise<void> {
  try {
    await shared.scheduler.send(new DeleteScheduleCommand({ Name: name }));
  } catch (err) {
    // EndDate 到達で aws-scheduler が既に自動削除済 / そもそも未作成 → no-op (= 冪等な解除)。
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
}

/**
 * 1 件の recurring を早期解除する: per-team の rate schedule を削除し、 registry に cancelledAt を刻む。
 * `tenantId` 不一致 (= 別テナントの requestId を当ててきた) は不在と同じく `not_found` を返し、 存在を
 * 漏らさない。 Update は `tenantId` 条件で atomic に scope する (多層防御 / Issue #997)。
 *
 * [Issue #2442 / Phase C3] DDB アクセス (Get + conditional Update) は repository seam に移設。
 * ownership 事前確認 (Get → tenantId 比較) + schedule 削除ループは業務ロジックとしてここに残す。
 */
export async function cancelRecurring(
  shared: EventSharedResources,
  eventId: string,
  tenantId: string,
  requestId: string,
  nowMs: number,
): Promise<CancelRecurringOutcome> {
  const repository = await resolveDisruptionsRepository(shared);
  const row = await repository.getRecurringRegistry(eventId, requestId);
  if (!row || row.tenantId !== tenantId) return "not_found";
  for (const teamId of row.affectedTeamIds) {
    await deleteScheduleIfExists(shared, recurringScheduleNameOf(requestId, teamId));
  }
  const outcome = await repository.cancelRecurringRegistry(
    eventId,
    requestId,
    tenantId,
    new Date(nowMs).toISOString(),
  );
  return outcome.outcome === "not_found" ? "not_found" : "cancelled";
}
