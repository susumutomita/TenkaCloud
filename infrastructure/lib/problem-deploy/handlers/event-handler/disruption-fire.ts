/**
 * Issue #888 Phase A: Red Team Disruption Fire の business logic。
 *
 * 流れ (= race-safe ordering、 PR #889 review fix 後):
 *   1. problemId / disruptionId を problemsDisruptions catalog で解決
 *   2. parameters を operatorEditable allow-list で fold (= 不正 key を reject)
 *   3. event 配下 team 一覧を取得し scope=all/team/random-n を解決 (= 母集団)
 *   4. **Idempotency claim (= REQUEST# row を conditional Put で奪取)**:
 *      - 成功 → こちらが winner、 publish + audit に進む
 *      - CCF + 既存 row 有 → duplicate、 前回 result を返す
 *      - CCF + race winner の row 未到達 → 短時間 sleep + 再 Get
 *   5. EventBridge publish (= FailedEntryCount > 0 で throw)
 *   6. AUDIT# row を Put
 *
 * 旧設計 (= 先 Query → publish → 後 Put) には race 窓があり、 同 requestId の 2 件が
 * 両方 publish に進めてしまう問題があったため、 publish の **前** に conditional Put で
 * 排他を取る形に書き換えた (PR #889 critical review)。
 *
 * cross-account publish (= 競技者アカウントへの forward) は Phase B で追加する。
 * 本 Phase A では同 account の event bus に publish するに留め、 audit + Logs Insights で
 * 観察可能にする。
 */

import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { ulid } from "ulid";
import type { TeamRecord } from "../../control-data/teams-repository.js";
import { putEventsBatched } from "../shared/events.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { writeRecurringRegistry } from "./disruption-recurring.js";
import type {
  DisruptionAuditRow,
  DisruptionFireInput,
  DisruptionFireOutcome,
  DisruptionFireResult,
} from "./disruption-types.js";
import {
  type EventSharedResources,
  resolveDisruptionsRepository,
  resolveEventsRepository,
  resolveTeamsRepository,
} from "./shared.js";

const EVENT_SOURCE = "tenkacloud.disruptions";
const AUDIT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_AFFECTED_TEAMS = 200;
const DUPLICATE_RESOLVE_RETRY_MS = 200;
const DUPLICATE_RESOLVE_RETRIES = 3;

/**
 * `targetTeamIds` の subset selection。 scope=all なら全件、 scope=team は dedupe して
 * 既存 team との intersection、 scope=random-n は crypto-grade Fisher-Yates で抽選。
 */
function resolveTargetTeams(
  scope: DisruptionFireInput["scope"],
  allTeams: readonly TeamRecord[],
  input: DisruptionFireInput,
): readonly string[] {
  if (scope === "all") {
    return allTeams.map((t) => t.teamId);
  }
  if (scope === "team") {
    // PR #889 review: input.targetTeamIds が同 id 重複を含む可能性があるため Set で dedupe。
    const validIds = new Set(allTeams.map((t) => t.teamId));
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of input.targetTeamIds) {
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }
  // scope === "random-n"
  const n = Math.min(Math.max(input.randomCount ?? 1, 1), allTeams.length);
  const pool = allTeams.map((t) => t.teamId);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = pool[i] as string;
    pool[i] = pool[j] as string;
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/**
 * PR #889 review: race-safe idempotency claim。 REQUEST# row を conditional Put で
 * 奪取し、 失敗時は同 row を Get して duplicate result を返す。
 *
 * loser 側で row の DDB 反映 (= 強い整合性ありの Get) を即時参照できる前提だが、 万一
 * eventual な race で row 未到達のケースに備え、 短時間 sleep + 再 Get で 1 度だけ retry。
 *
 * [Issue #2442 / Phase C3] Put/Get の DDB アクセスは repository seam (`resolveDisruptionsRepository`)
 * に移設。 claim outcome は A2 union 契約 (`claimed` / `already`) で表現し、 retry-sleep loop
 * (= 純粋な業務ロジック) はここに残す。
 */
async function tryClaimIdempotency(
  shared: EventSharedResources,
  input: DisruptionFireInput,
  draft: DisruptionAuditRow,
): Promise<{ kind: "claimed" } | { kind: "duplicate"; row: DisruptionAuditRow }> {
  const repository = await resolveDisruptionsRepository(shared);
  const claim = await repository.claimFireIdempotency(draft);
  if (claim.outcome === "claimed") return { kind: "claimed" };
  // loser: 既存 row を Get で取り直し、 duplicate を返す
  for (let attempt = 0; attempt <= DUPLICATE_RESOLVE_RETRIES; attempt++) {
    const duplicate = await repository.getFireIdempotencyRecord(input.tenantId, input.requestId);
    if (duplicate) return { kind: "duplicate", row: duplicate };
    if (attempt < DUPLICATE_RESOLVE_RETRIES) await sleep(DUPLICATE_RESOLVE_RETRY_MS);
  }
  // race winner が item 書き込み前に死んだ等の極端ケース: 自分が claim を取り直すために throw
  throw new Error(
    `disruption fire idempotency claim failed for requestId=${input.requestId}: ` +
      "conditional check failed but no prior row visible after retries",
  );
}

/**
 * Phase A の fire 実装。 caller (handler/index.ts) が JWT 認可 + tenantId scoping を済ませた
 * 前提で呼ぶ。 cross-tenant fire 防止は handler 側で `event.tenantId === ctx.tenantId` を
 * assert する責務。
 */
export async function fireDisruption(
  shared: EventSharedResources,
  input: DisruptionFireInput,
): Promise<DisruptionFireOutcome> {
  // 1. catalog lookup
  const catalog = shared.problemsDisruptions[input.problemId];
  if (!catalog) return { kind: "unknown_problem" };
  const declaration = catalog.find((d) => d.id === input.disruptionId);
  if (!declaration) return { kind: "unknown_disruption" };

  // 2. parameters allow-list 検証 (= operatorEditable に無い key を reject)
  const allow = new Set(declaration.operatorEditable ?? []);
  for (const key of Object.keys(input.parameters)) {
    if (!allow.has(key)) {
      return {
        kind: "invalid_parameters",
        reason: `parameter '${key}' is not in operatorEditable allow-list`,
      };
    }
  }
  const mergedParameters: Record<string, unknown> = {
    ...(declaration.parameters ?? {}),
    ...input.parameters,
  };

  // 3. event 配下 team 一覧 → scope 解決。 teams-only seam 経由 (= base-table query、
  // teamId 昇順の TeamRecord[])。 resolveTargetTeams は teamId しか読まないので挙動は不変。
  const teams = await resolveTeamsRepository(shared);
  const allTeams = await teams.listTeamsByEvent(input.eventId);
  if (allTeams.length === 0) return { kind: "no_targets" };
  const affected = resolveTargetTeams(input.scope, allTeams, input);
  if (affected.length === 0) return { kind: "no_targets" };
  if (affected.length > MAX_AFFECTED_TEAMS) {
    return { kind: "invalid_scope", reason: `too many target teams: ${affected.length}` };
  }

  const auditId = ulid();
  const firedAt = new Date(input.nowMs).toISOString();
  const expiresAt = Math.floor(input.nowMs / 1000) + AUDIT_TTL_SECONDS;
  // scheduled fire: 実際の注入予定時刻を audit に残す (「N 分後に予約」 を可視化)。
  // afterMinutes は route で 1..1440 に validate 済 (= 未指定 / 0 は即時 fire)。
  const scheduledFor = input.afterMinutes
    ? new Date(input.nowMs + input.afterMinutes * 60_000).toISOString()
    : undefined;
  const draft: DisruptionAuditRow = {
    auditId,
    tenantId: input.tenantId,
    eventId: input.eventId,
    problemId: input.problemId,
    disruptionId: input.disruptionId,
    firedBy: input.firedBy,
    firedAt,
    scope: input.scope,
    targetTeamIds: affected,
    parameters: mergedParameters,
    requestId: input.requestId,
    expiresAt,
    ...(scheduledFor ? { scheduledFor } : {}),
  };

  // 4. Idempotency claim (= publish 前に排他を取る、 race-safe な順序)
  const claim = await tryClaimIdempotency(shared, input, draft);
  if (claim.kind === "duplicate") {
    return {
      kind: "duplicate",
      result: {
        auditId: claim.row.auditId,
        firedAt: claim.row.firedAt,
        affectedTeamIds: claim.row.targetTeamIds,
      },
    };
  }

  // 5. EventBridge publish (= FailedEntryCount > 0 で throw、 audit 整合性確保)
  await publishEntries(
    shared,
    input,
    declaration.eventDetailType,
    affected,
    firedAt,
    mergedParameters,
  );

  // 6. AUDIT# row を Put (= append-only audit log)。 同 SK の上書きを防ぐ (= 万一 ULID collision
  // でも reject) — repository の `appendAudit` が verbatim に持つ。
  const repository = await resolveDisruptionsRepository(shared);
  await repository.appendAudit(draft);

  // 6b. recurring fire は RECUR# registry row も書く (operator が一覧 / 早期解除する
  // ための索引)。 詳細は disruption-recurring.writeRecurringRegistry (非 recurring は no-op)。
  await writeRecurringRegistry(shared, input, affected, firedAt, expiresAt);

  logDeployTrace("disruption.fire", {
    auditId,
    eventId: input.eventId,
    problemId: input.problemId,
    disruptionId: input.disruptionId,
    scope: input.scope,
    affectedCount: affected.length,
  });

  return {
    kind: "ok",
    result: { auditId, firedAt, affectedTeamIds: affected } satisfies DisruptionFireResult,
  };
}

async function publishEntries(
  shared: EventSharedResources,
  input: DisruptionFireInput,
  detailType: string,
  affectedTeamIds: readonly string[],
  firedAt: string,
  mergedParameters: Readonly<Record<string, unknown>>,
): Promise<void> {
  // PR #889 review: publish 内容は audit に書く mergedParameters と一致させる
  // (= 旧コードは input.parameters のみで base parameters を欠いていた)。
  const items: Array<{ item: string; entry: PutEventsRequestEntry }> = affectedTeamIds.map(
    (teamId) => ({
      item: teamId,
      entry: {
        Source: EVENT_SOURCE,
        DetailType: detailType,
        EventBusName: shared.eventBusName,
        Detail: JSON.stringify({
          disruptionId: input.disruptionId,
          eventId: input.eventId,
          problemId: input.problemId,
          tenantId: input.tenantId,
          teamId,
          parameters: mergedParameters,
          requestId: input.requestId,
          firedAt,
          // scheduled fire: executor がこの分数だけ注入を遅延予約する。 即時は省略。
          ...(input.afterMinutes ? { afterMinutes: input.afterMinutes } : {}),
          // recurring fire: executor が rate(intervalMinutes) schedule を作る。 即時/予約では省略。
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
        }),
      },
    }),
  );
  // PR #889 review: PutEvents は HTTP 200 でも entry 単位の失敗を返す。 FailedEntryCount を
  // 必ず確認し、 失敗があれば throw して audit 行を書かないようにする (= 整合性確保)。
  const results = await putEventsBatched(shared.events, items);
  const failureDetails = results
    .filter((r) => !r.success)
    .map((r) => ({ teamId: r.item, errorCode: r.errorCode ?? "unknown" }));
  if (failureDetails.length > 0) {
    throw new Error(
      `disruption publish partial failure: ${failureDetails
        .map((f) => `team[${f.teamId}]=${f.errorCode}`)
        .join(", ")}`,
    );
  }
}

/**
 * PR #889 review: tenant ownership check。 catalog / audit / fire の各 endpoint で
 * 呼び出し前に event.tenantId === callerTenantId を確認するための shared helper。
 *
 * not found / tenant mismatch のどちらも `false` を返す (= info leak 防止のため区別しない)。
 */
export async function isEventOwnedByTenant(
  shared: EventSharedResources,
  eventId: string,
  tenantId: string,
): Promise<boolean> {
  // getEvent は tenant 不一致 / 不在をどちらも undefined に畳むので、 undefined でなければ
  // 「その tenant が所有する event」 (= 従来の `!!item && item.tenantId === tenantId` と等価)。
  const events = await resolveEventsRepository(shared);
  const event = await events.getEvent(tenantId, eventId);
  return event !== undefined;
}

/**
 * Issue #888 FR-4: audit log の page query。 cursor-based pagination。
 *
 * [Issue #2442 / Phase C3] DDB アクセスは repository seam (`resolveDisruptionsRepository`) に
 * 移設。 limit clamp (1..200 既定 50) は caller-facing 業務ロジックとしてここに残す。
 */
export async function listDisruptionAudit(
  shared: EventSharedResources,
  eventId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: DisruptionAuditRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const repository = await resolveDisruptionsRepository(shared);
  const page = await repository.listAuditPage(eventId, {
    limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return {
    items: [...page.items],
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * Issue #888 FR-2: 該当 event に deploy された problem の disruption catalog を返す。
 *
 * event item から problems[] を引き、 problemId 毎に problemsDisruptions catalog を merge。
 * publicHint=false の disruption も TenantAdmin 向けには返す (= operator view が前提)。
 *
 * PR #889 review: 呼び出し側 (handler/index.ts) で tenantId 一致を確認した上で呼ぶ前提。
 * その tenantId を getEvent に渡すことで、 seam の tenant scope が呼び出し側の所有確認と
 * 一致する (= 従来の tenant-agnostic Get + 呼び出し側の事前確認と等価)。
 */
export async function listDisruptionCatalog(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
): Promise<{
  entries: Array<{
    problemId: string;
    disruption: (typeof shared.problemsDisruptions)[string][number];
  }>;
}> {
  const events = await resolveEventsRepository(shared);
  const event = await events.getEvent(tenantId, eventId);
  const problemIds = Array.isArray(event?.problems)
    ? event.problems.map((p) => p.problemId).filter((p): p is string => typeof p === "string")
    : [];
  const entries: Array<{
    problemId: string;
    disruption: (typeof shared.problemsDisruptions)[string][number];
  }> = [];
  for (const problemId of problemIds) {
    const cat = shared.problemsDisruptions[problemId];
    if (!cat) continue;
    for (const d of cat) {
      entries.push({ problemId, disruption: d });
    }
  }
  return { entries };
}
