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
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { logDeployTrace } from "../shared/trace-log.js";
import type {
  DisruptionAuditRow,
  DisruptionFireInput,
  DisruptionFireOutcome,
  DisruptionFireResult,
} from "./disruption-types.js";
import type { EventSharedResources } from "./shared.js";
import type { TeamItem } from "./types.js";

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
  allTeams: readonly TeamItem[],
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
 */
async function tryClaimIdempotency(
  shared: EventSharedResources,
  input: DisruptionFireInput,
  draft: DisruptionAuditRow,
): Promise<{ kind: "claimed" } | { kind: "duplicate"; row: DisruptionAuditRow }> {
  const idempotencyKey = `REQUEST#${input.tenantId}#${input.requestId}`;
  try {
    await shared.ddb.send(
      new PutCommand({
        TableName: shared.disruptionsTableName,
        Item: {
          PK: idempotencyKey,
          SK: "METADATA",
          GSI1PK: idempotencyKey,
          GSI1SK: "METADATA",
          ...draft,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return { kind: "claimed" };
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  // loser: 既存 row を Get で取り直し、 duplicate を返す
  for (let attempt = 0; attempt <= DUPLICATE_RESOLVE_RETRIES; attempt++) {
    const duplicate = await getDuplicateDisruption(shared, input, idempotencyKey);
    if (duplicate) return { kind: "duplicate", row: duplicate };
    if (attempt < DUPLICATE_RESOLVE_RETRIES) await sleep(DUPLICATE_RESOLVE_RETRY_MS);
  }
  // race winner が item 書き込み前に死んだ等の極端ケース: 自分が claim を取り直すために throw
  throw new Error(
    `disruption fire idempotency claim failed for requestId=${input.requestId}: ` +
      "conditional check failed but no prior row visible after retries",
  );
}

async function getDuplicateDisruption(
  shared: EventSharedResources,
  input: DisruptionFireInput,
  idempotencyKey: string,
): Promise<DisruptionAuditRow | undefined> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.disruptionsTableName,
      Key: { PK: idempotencyKey, SK: "METADATA" },
      ConsistentRead: true,
    }),
  );
  const item = out.Item as Partial<DisruptionAuditRow> | undefined;
  return item?.auditId ? normalizeDuplicateDisruption(item, item.auditId, input) : undefined;
}

function normalizeDuplicateDisruption(
  item: Partial<DisruptionAuditRow>,
  auditId: string,
  input: DisruptionFireInput,
): DisruptionAuditRow {
  return {
    auditId,
    tenantId: String(item.tenantId ?? input.tenantId),
    eventId: String(item.eventId ?? input.eventId),
    problemId: String(item.problemId ?? input.problemId),
    disruptionId: String(item.disruptionId ?? input.disruptionId),
    firedBy: String(item.firedBy ?? input.firedBy),
    firedAt: String(item.firedAt ?? new Date(input.nowMs).toISOString()),
    scope: (item.scope ?? input.scope) as DisruptionFireInput["scope"],
    targetTeamIds: Array.isArray(item.targetTeamIds) ? (item.targetTeamIds as string[]) : [],
    parameters: (item.parameters && typeof item.parameters === "object"
      ? item.parameters
      : {}) as Readonly<Record<string, unknown>>,
    requestId: String(item.requestId ?? input.requestId),
    expiresAt: Number(item.expiresAt ?? 0),
  };
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

  // 3. event 配下 team 一覧 → scope 解決
  const allTeams = await listTeamsByEvent(shared, input.eventId);
  if (allTeams.length === 0) return { kind: "no_targets" };
  const affected = resolveTargetTeams(input.scope, allTeams, input);
  if (affected.length === 0) return { kind: "no_targets" };
  if (affected.length > MAX_AFFECTED_TEAMS) {
    return { kind: "invalid_scope", reason: `too many target teams: ${affected.length}` };
  }

  const auditId = ulid();
  const firedAt = new Date(input.nowMs).toISOString();
  const expiresAt = Math.floor(input.nowMs / 1000) + AUDIT_TTL_SECONDS;
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

  // 6. AUDIT# row を Put (= append-only audit log)
  await shared.ddb.send(
    new PutCommand({
      TableName: shared.disruptionsTableName,
      Item: {
        PK: `EVENT#${input.eventId}`,
        SK: `AUDIT#${firedAt}#${auditId}`,
        GSI1PK: `TENANT#${input.tenantId}`,
        GSI1SK: `AUDIT#${firedAt}#${auditId}`,
        ...draft,
      },
      // 同 SK の上書きを防ぐ (= 万一 ULID collision でも reject)
      ConditionExpression: "attribute_not_exists(SK)",
    }),
  );

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

async function listTeamsByEvent(
  shared: EventSharedResources,
  eventId: string,
): Promise<readonly TeamItem[]> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.teamsTableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :tprefix)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":tprefix": "TEAM#" },
    }),
  );
  return (out.Items ?? []) as TeamItem[];
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
  const entries: PutEventsRequestEntry[] = affectedTeamIds.map((teamId) => ({
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
    }),
  }));
  const BATCH = 10;
  const failureDetails: Array<{ entryIndex: number; errorCode: string; errorMessage: string }> = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const resp = await shared.events.send(new PutEventsCommand({ Entries: chunk }));
    // PR #889 review: PutEvents は HTTP 200 でも entry 単位の失敗を返す。 FailedEntryCount を
    // 必ず確認し、 失敗があれば throw して audit 行を書かないようにする (= 整合性確保)。
    if ((resp.FailedEntryCount ?? 0) > 0) {
      for (const [idx, e] of (resp.Entries ?? []).entries()) {
        if (e.ErrorCode) {
          failureDetails.push({
            entryIndex: i + idx,
            errorCode: e.ErrorCode,
            errorMessage: e.ErrorMessage ?? "",
          });
        }
      }
    }
  }
  if (failureDetails.length > 0) {
    throw new Error(
      `disruption publish partial failure: ${failureDetails
        .map((f) => `entry[${f.entryIndex}]=${f.errorCode}`)
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
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
    }),
  );
  const item = out.Item as { tenantId?: string } | undefined;
  return !!item && item.tenantId === tenantId;
}

/**
 * Issue #888 FR-4: audit log の page query。 cursor-based pagination。
 */
export async function listDisruptionAudit(
  shared: EventSharedResources,
  eventId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: DisruptionAuditRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const exclusiveStartKey = options.cursor ? decodeCursor(options.cursor) : undefined;
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.disruptionsTableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :ap)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":ap": "AUDIT#" },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );
  const items: DisruptionAuditRow[] = (out.Items ?? []).map((raw) => {
    const r = raw as Partial<DisruptionAuditRow> & Record<string, unknown>;
    return {
      auditId: String(r.auditId ?? ""),
      tenantId: String(r.tenantId ?? ""),
      eventId: String(r.eventId ?? ""),
      problemId: String(r.problemId ?? ""),
      disruptionId: String(r.disruptionId ?? ""),
      firedBy: String(r.firedBy ?? ""),
      firedAt: String(r.firedAt ?? ""),
      scope: (r.scope ?? "team") as DisruptionAuditRow["scope"],
      targetTeamIds: Array.isArray(r.targetTeamIds)
        ? (r.targetTeamIds as string[])
        : ([] as readonly string[]),
      parameters: (r.parameters && typeof r.parameters === "object"
        ? r.parameters
        : {}) as Readonly<Record<string, unknown>>,
      requestId: String(r.requestId ?? ""),
      expiresAt: Number(r.expiresAt ?? 0),
    };
  });
  return {
    items,
    ...(out.LastEvaluatedKey
      ? { nextCursor: encodeCursor(out.LastEvaluatedKey as Record<string, unknown>) }
      : {}),
  };
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  if (cursor.length > 512) return undefined;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const allow = new Set(["PK", "SK", "GSI1PK", "GSI1SK"]);
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!allow.has(k)) return undefined;
      if (typeof v !== "string" || v.length === 0 || v.length > 256) return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Issue #888 FR-2: 該当 event に deploy された problem の disruption catalog を返す。
 *
 * event item から problems[] を引き、 problemId 毎に problemsDisruptions catalog を merge。
 * publicHint=false の disruption も TenantAdmin 向けには返す (= operator view が前提)。
 *
 * PR #889 review: 呼び出し側 (handler/index.ts) で tenantId 一致を確認した上で呼ぶ前提。
 */
export async function listDisruptionCatalog(
  shared: EventSharedResources,
  eventId: string,
): Promise<{
  entries: Array<{
    problemId: string;
    disruption: (typeof shared.problemsDisruptions)[string][number];
  }>;
}> {
  const out = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
    }),
  );
  const event = out.Item as { problems?: Array<{ problemId: string }> } | undefined;
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
