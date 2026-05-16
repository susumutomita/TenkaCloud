/**
 * Issue #888 Phase A: Red Team Disruption Fire の business logic。
 *
 * 流れ:
 *   1. problemId / disruptionId を problemsDisruptions catalog で解決
 *   2. parameters を operatorEditable allow-list で fold (= 不正 key を reject)
 *   3. scope に応じて targetTeamIds を解決 (= all / team / random-n)
 *   4. requestId Idempotency lookup (= GSI1 で `REQUEST#<id>` を引く)
 *   5. EventBridge に detail-type=<disruption.eventDetailType> で N team 分 publish
 *   6. DDB に 1 audit row + 1 idempotency row を書く
 *
 * cross-account publish (= 競技者アカウントへの forward) は Phase B で追加する。
 * 本 Phase A では同 account の event bus に publish するに留め、 audit + Logs Insights で
 * 観察可能にする。
 */

import { randomInt } from "node:crypto";
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

/**
 * `targetTeamIds` の subset selection。 scope=all なら全件、 scope=team は input そのまま、
 * scope=random-n は crypto-grade Fisher-Yates で randomCount 件抽選。
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
    const ids = new Set(allTeams.map((t) => t.teamId));
    return input.targetTeamIds.filter((id) => ids.has(id));
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

  // 3. Idempotency: requestId 既存 → 前回結果を返す
  const idempotencyKey = `REQUEST#${input.tenantId}#${input.requestId}`;
  const prior = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.disruptionsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": idempotencyKey },
      Limit: 1,
    }),
  );
  const priorItem = prior.Items?.[0] as Partial<DisruptionAuditRow> | undefined;
  if (priorItem?.auditId) {
    return {
      kind: "duplicate",
      result: {
        auditId: priorItem.auditId,
        firedAt: priorItem.firedAt ?? new Date(input.nowMs).toISOString(),
        affectedTeamIds: priorItem.targetTeamIds ?? [],
      },
    };
  }

  // 4. event 配下 team 一覧を取得 (= scope 解決の母集団)
  const allTeams = await listTeamsByEvent(shared, input.eventId);
  if (allTeams.length === 0) return { kind: "no_targets" };

  const affected = resolveTargetTeams(input.scope, allTeams, input);
  if (affected.length === 0) return { kind: "no_targets" };
  if (affected.length > MAX_AFFECTED_TEAMS) {
    return { kind: "invalid_scope", reason: `too many target teams: ${affected.length}` };
  }

  const auditId = ulid();
  const firedAt = new Date(input.nowMs).toISOString();
  const result: DisruptionFireResult = { auditId, firedAt, affectedTeamIds: affected };

  // 5. EventBridge publish: 1 PutEvents = 10 entries 上限。 chunk 分割で全 affected を流す。
  await publishEntries(shared, input, declaration.eventDetailType, affected, firedAt);

  // 6. DDB audit + idempotency row を 2 PutItem で書く (= TransactWrite だと 25 row 制限が
  //    別 audit 経路と相互作用するため Phase A では 2 separate PutItem)。
  const expiresAt = Math.floor(input.nowMs / 1000) + AUDIT_TTL_SECONDS;
  const auditRow: DisruptionAuditRow = {
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
  try {
    await shared.ddb.send(
      new PutCommand({
        TableName: shared.disruptionsTableName,
        Item: {
          PK: `EVENT#${input.eventId}`,
          SK: `AUDIT#${firedAt}#${auditId}`,
          GSI1PK: `TENANT#${input.tenantId}`,
          GSI1SK: `AUDIT#${firedAt}#${auditId}`,
          ...auditRow,
        },
        // append-only: 同 SK の上書きを防ぐ (= 万一 ULID collision でも reject)
        ConditionExpression: "attribute_not_exists(SK)",
      }),
    );
    await shared.ddb.send(
      new PutCommand({
        TableName: shared.disruptionsTableName,
        Item: {
          PK: idempotencyKey,
          SK: "METADATA",
          GSI1PK: idempotencyKey,
          GSI1SK: "METADATA",
          ...auditRow,
        },
        // requestId 重複は手前の Query 段で吸収するが、 並列 fire の race を condition で守る
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // race で先勝されたらこちらは duplicate 扱いに倒す (= idempotent return)。
      return { kind: "duplicate", result };
    }
    throw err;
  }

  logDeployTrace("disruption.fire", {
    auditId,
    eventId: input.eventId,
    problemId: input.problemId,
    disruptionId: input.disruptionId,
    scope: input.scope,
    affectedCount: affected.length,
  });

  return { kind: "ok", result };
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
): Promise<void> {
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
      parameters: input.parameters,
      requestId: input.requestId,
      firedAt,
    }),
  }));
  const BATCH = 10;
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    await shared.events.send(new PutEventsCommand({ Entries: chunk }));
  }
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
