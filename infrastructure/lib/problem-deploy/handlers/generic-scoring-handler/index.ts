import {
  BatchGetCommand,
  type DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { buildEndpointPK } from "../../problem-endpoints-table.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { reconcileEventStatuses } from "./event-reconciler.js";
import { runAttackDetectionKind } from "./kinds/attack-detection.js";
import { runPhasedPollingKind } from "./kinds/phased-polling.js";
import { runUptimeFlatKind } from "./kinds/uptime-flat.js";
import { runUptimeMultiKind } from "./kinds/uptime-multi.js";
import { isScoringActive } from "./scoring-active.js";
import {
  buildSharedResources,
  type GenericScoringSharedResources,
  type KindHandlerInput,
  type KindResult,
  type PhaseEntry,
  parseScoringState,
} from "./shared.js";

/**
 * Generic scoring dispatcher Lambda (ADR-012 Phase 3.B、 旧 health-check-handler の責務を引き継ぐ)。
 *
 * EventBridge Scheduler `rate(1 minute)` で起動。 2 つの責務を並列で動かす:
 *
 * 1. **採点 dispatch**: Deployments table を Scan し、 `status=COMPLETE` な行について
 *    `metadata.scoring.kind` を読み、 5 種の builtin kind handler に dispatch する。
 *    - `flag`              → polling では何もしない (= submit-flag が event-triggered で扱う)
 *    - `uptime-flat` / `uptime` → endpoint 群を probe、 全 ok で pointsPerSuccess 加点
 *    - `uptime-multi`      → N slot probe、 全 ok で pointsAllOk / 1 fail で failurePenalty
 *    - `phased-polling`    → time-based rule + platform 分類 + bonus
 *    - `attack-detection`  → CFn Output 内 counter の増分で加点
 *
 * 2. **Event status reconcile** (#557 #539): Events table の `DEPLOYING` / `TEARDOWN` 行を
 *    子 deployment 集約 status で `READY` / `ARCHIVED` に遷移させる。
 *
 * 両者は別 table / 別 row で独立。 `Promise.all` で並列実行する。
 *
 * MVP-1 規模 (~50 deployments) は Scan + FilterExpression で十分。 Phase 2+ で 100+ になったら
 * GSI3 (PK=STATUS) で query 化を検討。
 */

export async function handler(): Promise<void> {
  const shared = buildSharedResources();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Event status reconcile (#557 #539) を採点と並列実行。1 tick の失敗は次 tick で再評価。
  const reconcilePromise = reconcileEventStatuses(
    {
      ddb: shared.ddb,
      eventsTableName: shared.eventsTableName,
      deploymentsTableName: shared.deploymentsTableName,
    },
    nowIso,
  ).catch((err) => {
    console.warn("[generic-scoring] reconcileEventStatuses failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // metadata.json の `phases[]` は scoring とは別 field なので、 dispatcher で per-problemId
  // に展開する。Phase 3.B では `BATTLE_PROBLEMS_PHASES` env で渡す (= Lambda 配線で
  // discoverProblemsPhases から JSON 化)。env が無い場合は空 (= phases 無し)。
  const phasesByProblemId = parsePhasesEnv(process.env.BATTLE_PROBLEMS_PHASES);

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await shared.ddb.send(
      new ScanCommand({
        TableName: shared.deploymentsTableName,
        FilterExpression: "#status = :complete",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":complete": "COMPLETE" },
        Limit: 200,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Partial<DeploymentItem>[];

    // #558: deployment が属する event の `scoringLocked` を per-invocation で BatchGet 取得。
    const lockedMap = await fetchScoringLockedMap(shared, items);

    await Promise.all(
      items.map(async (item) => {
        await processDeployment(shared, item, lockedMap, phasesByProblemId, nowMs, nowIso).catch(
          (err) => {
            console.warn(`[generic-scoring] processDeployment failed jobId=${item.jobId}`, {
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }),
    );
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  await reconcilePromise;
}

/**
 * 1 deployment を 5 kind dispatcher で採点。`scoring` が無い問題は no-op。
 * `eventStartsAt` / `eventEndsAt` で gate、 `scoringLocked` event は skip。
 */
async function processDeployment(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  lockedMap: Map<string, boolean>,
  phasesByProblemId: Record<string, readonly PhaseEntry[]>,
  nowMs: number,
  nowIso: string,
): Promise<void> {
  if (!item.problemId || !item.tenantId || !item.teamId) {
    // Phase 1 以前の旧 deployment は teamId / eventId を持たない → 採点 skip
    return;
  }
  if (!isScoringActive(item, nowIso)) return;
  if (item.eventId && lockedMap.get(item.eventId) === true) return;

  const scoring = shared.problemsScoring[item.problemId];
  if (!scoring) return;
  // flag は polling 経路では何もしない。submit-flag (event-trigger) が採点する。
  if (scoring.kind === "flag") return;

  const slots = shared.problemsEndpoints[item.problemId] ?? [];
  // Phase 3.A: 当該 (tenant, team, problem) の override 行を query (= 1 RCU 程度)
  const overrides = await queryOverridesForDeployment(
    shared.ddb,
    shared.endpointsTableName,
    item.tenantId,
    item.teamId,
    item.problemId,
  );

  const prevState = parseScoringState(item.scoringState);

  const input: KindHandlerInput = {
    deployment: item,
    scoring,
    slots,
    overrides,
    phases: phasesByProblemId[item.problemId] ?? [],
    nowMs,
    nowIso,
    prevState,
  };

  let result: KindResult;
  if (scoring.kind === "uptime" || scoring.kind === "uptime-flat") {
    result = await runUptimeFlatKind({ ...input, scoring });
  } else if (scoring.kind === "uptime-multi") {
    result = await runUptimeMultiKind({ ...input, scoring });
  } else if (scoring.kind === "phased-polling") {
    result = await runPhasedPollingKind({ ...input, scoring });
  } else if (scoring.kind === "attack-detection") {
    result = runAttackDetectionKind({ ...input, scoring });
  } else {
    return;
  }

  await applyKindResult(shared, item, result, nowIso);
}

/**
 * KindResult を deployment 行に書き戻す。 score 加算 / endpointsHealth 更新 / lastResult 更新 /
 * scoringState 更新 を 1 UpdateItem で atomic に行う。 score event 行 (= ulid SK の sparse row)
 * は別途 best-effort で書く。
 */
async function applyKindResult(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
  nowIso: string,
): Promise<void> {
  if (!item.PK) return;

  // UpdateExpression を field 存在に応じて動的に組む。常に updatedAt / lastScoredAt を更新。
  const setParts: string[] = ["lastScoredAt = :now", "updatedAt = :now"];
  const exprValues: Record<string, unknown> = { ":now": nowIso };
  let updateExpr = "";

  if (result.scoreDelta !== 0) {
    updateExpr = "ADD score :pts ";
    exprValues[":pts"] = result.scoreDelta;
  }
  if (result.lastResult) {
    setParts.push("lastResult = :lr");
    exprValues[":lr"] = result.lastResult;
  }
  if (result.endpointsHealthJson !== undefined) {
    setParts.push("endpointsHealth = :health");
    exprValues[":health"] = result.endpointsHealthJson;
  }
  if (result.newState !== undefined) {
    setParts.push("scoringState = :state");
    exprValues[":state"] = JSON.stringify(result.newState);
  }
  updateExpr += `SET ${setParts.join(", ")}`;

  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.deploymentsTableName,
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: exprValues,
      }),
    );
  } catch (err) {
    console.warn(`[generic-scoring] UpdateItem failed jobId=${item.jobId}`, {
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // score event 行 (= 履歴 marker) を best-effort で append。失敗は警告 log のみ
  // (= 採点 / 健全性 update は既に確定済、整合性より可用性優先)。
  if (!item.jobId || !item.problemId) return;
  const parent = {
    jobId: item.jobId,
    problemId: item.problemId,
    teamId: item.teamId,
    eventId: item.eventId,
    expiresAt: item.expiresAt ?? 0,
  };
  for (const ev of result.scoreEvents) {
    try {
      await writeScoreEvent(
        shared.ddb,
        shared.deploymentsTableName,
        parent,
        ev.source,
        ev.points,
        ev.occurredAt,
      );
    } catch (err) {
      console.warn(`[generic-scoring] score-event write failed jobId=${item.jobId}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 1 (tenant, team, problem) の override 行を Query で全件引く (= slot 数 << 10)。
 */
export async function queryOverridesForDeployment(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  teamId: string,
  problemId: string,
): Promise<{ readonly slot: string; readonly overrideUrl: string }[]> {
  if (!tableName) return [];
  try {
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": buildEndpointPK(tenantId, teamId, problemId),
          ":sk": "SLOT#",
        },
      }),
    );
    const items = (out.Items ?? []) as Array<{ slot?: string; overrideUrl?: string }>;
    return items
      .filter(
        (i): i is { slot: string; overrideUrl: string } =>
          typeof i.slot === "string" &&
          typeof i.overrideUrl === "string" &&
          i.overrideUrl.length > 0,
      )
      .map((i) => ({ slot: i.slot, overrideUrl: i.overrideUrl }));
  } catch (err) {
    console.warn("[generic-scoring] queryOverrides failed (treat as no override)", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * #558: 同 invocation 内 deployments の distinct eventId について Events table を BatchGet
 * し、 scoringLocked=true な eventId の Map を返す。
 *
 * Phase 3.B で health-check-handler から本 module へ relocate (= 動作不変)。
 */
async function fetchScoringLockedMap(
  shared: GenericScoringSharedResources,
  items: readonly Partial<DeploymentItem>[],
): Promise<Map<string, boolean>> {
  const eventIds = Array.from(
    new Set(
      items
        .map((i) => i.eventId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (eventIds.length === 0) return new Map();
  try {
    const out = await shared.ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [shared.eventsTableName]: {
            Keys: eventIds.map((eventId) => ({ PK: `EVENT#${eventId}`, SK: "META" })),
            ProjectionExpression: "eventId, scoringLocked",
          },
        },
      }),
    );
    const rows = out.Responses?.[shared.eventsTableName] ?? [];
    const map = new Map<string, boolean>();
    for (const row of rows) {
      const r = row as { eventId?: string; scoringLocked?: boolean };
      if (typeof r.eventId === "string" && r.scoringLocked === true) {
        map.set(r.eventId, true);
      }
    }
    return map;
  } catch (err) {
    console.warn("[generic-scoring] fetchScoringLockedMap failed (fail-open)", {
      message: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * `BATTLE_PROBLEMS_PHASES` env を decode (= `{ [problemId]: PhaseEntry[] }`)。
 * 不正 entry は drop、 値が無ければ空 map。
 */
export function parsePhasesEnv(raw: string | undefined): Record<string, readonly PhaseEntry[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, readonly PhaseEntry[]> = {};
  for (const [problemId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const phases: PhaseEntry[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const p = entry as { name?: unknown; afterMinutes?: unknown; effect?: unknown };
      if (typeof p.name !== "string" || typeof p.afterMinutes !== "number") continue;
      const effectInput =
        p.effect && typeof p.effect === "object"
          ? (p.effect as Record<string, unknown>)
          : undefined;
      const effect = effectInput
        ? {
            ...(typeof effectInput.scorePathOverride === "string"
              ? { scorePathOverride: effectInput.scorePathOverride }
              : {}),
            ...(Array.isArray(effectInput.switchPlatformToDegraded)
              ? {
                  switchPlatformToDegraded: effectInput.switchPlatformToDegraded.filter(
                    (s): s is string => typeof s === "string",
                  ),
                }
              : {}),
          }
        : undefined;
      phases.push({
        name: p.name,
        afterMinutes: p.afterMinutes,
        ...(effect ? { effect } : {}),
      });
    }
    if (phases.length > 0) out[problemId] = phases;
  }
  return out;
}

export {
  reconcileEventStatuses,
  resolveEventStatusTransition,
} from "./event-reconciler.js";
// Re-export pure helpers for tests
export { isScoringActive } from "./scoring-active.js";
