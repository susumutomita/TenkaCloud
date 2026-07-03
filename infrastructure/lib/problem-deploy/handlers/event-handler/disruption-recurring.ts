/**
 * [ADR-037 Slice 2] recurring disruption の一覧 / 早期解除 (operator 用)。
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
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { recurringScheduleNameOf } from "../disruption-executor-handler/schedule-revert.js";
import type { DisruptionFireInput } from "./disruption-types.js";
import type { EventSharedResources } from "./shared.js";

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
 * [ADR-037 Slice 2] recurring fire のとき registry 行 (`EVENT#{eventId}` / `RECUR#{requestId}`) を書く。
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
  await shared.ddb.send(
    new PutCommand({
      TableName: shared.disruptionsTableName,
      Item: {
        PK: `EVENT#${input.eventId}`,
        SK: `RECUR#${input.requestId}`,
        GSI1PK: `TENANT#${input.tenantId}`,
        GSI1SK: `RECUR#${firedAt}#${input.requestId}`,
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
      },
      ConditionExpression: "attribute_not_exists(SK)",
    }),
  );
}

function toActiveRow(item: Record<string, unknown>): ActiveRecurringRow {
  return {
    requestId: String(item.requestId ?? ""),
    problemId: String(item.problemId ?? ""),
    disruptionId: String(item.disruptionId ?? ""),
    firedBy: String(item.firedBy ?? ""),
    firedAt: String(item.firedAt ?? ""),
    scope: String(item.scope ?? ""),
    affectedTeamIds: Array.isArray(item.affectedTeamIds) ? (item.affectedTeamIds as string[]) : [],
    intervalMinutes: Number(item.intervalMinutes ?? 0),
    maxFires: Number(item.maxFires ?? 0),
    endsAt: String(item.endsAt ?? ""),
  };
}

/**
 * event の RECUR# registry 行のうち、 まだ動いている (未 cancel + endsAt > now) ものを返す。
 * route 側 `requireEventOwnership` に加え、 service でも `tenantId` で FilterExpression scope する
 * (= 多層防御。 INVARIANT_TENANT_ISOLATION / Issue #997)。
 */
export async function listActiveRecurring(
  shared: EventSharedResources,
  eventId: string,
  tenantId: string,
  nowMs: number,
): Promise<ListRecurringResponse> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.disruptionsTableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      FilterExpression: "tenantId = :t",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":p": "RECUR#", ":t": tenantId },
    }),
  );
  const now = new Date(nowMs).toISOString();
  const items = (out.Items ?? [])
    .filter((i) => !i.cancelledAt && String(i.endsAt ?? "") > now)
    .map(toActiveRow);
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
 * 漏らさない。 Update は `ConditionExpression: tenantId = :t` で atomic に scope する (多層防御 / Issue #997)。
 */
export async function cancelRecurring(
  shared: EventSharedResources,
  eventId: string,
  tenantId: string,
  requestId: string,
  nowMs: number,
): Promise<CancelRecurringOutcome> {
  const key = { PK: `EVENT#${eventId}`, SK: `RECUR#${requestId}` };
  const got = await shared.ddb.send(
    new GetCommand({ TableName: shared.disruptionsTableName, Key: key }),
  );
  const row = got.Item;
  if (!row || row.tenantId !== tenantId) return "not_found";
  const teamIds = Array.isArray(row.affectedTeamIds) ? (row.affectedTeamIds as string[]) : [];
  for (const teamId of teamIds) {
    await deleteScheduleIfExists(shared, recurringScheduleNameOf(requestId, teamId));
  }
  await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.disruptionsTableName,
      Key: key,
      UpdateExpression: "SET cancelledAt = :c",
      ConditionExpression: "tenantId = :t",
      ExpressionAttributeValues: { ":c": new Date(nowMs).toISOString(), ":t": tenantId },
    }),
  );
  return "cancelled";
}
