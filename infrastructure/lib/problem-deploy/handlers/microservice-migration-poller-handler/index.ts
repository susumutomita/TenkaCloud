import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { fetchPlatform, probeScore } from "./probe.js";
import {
  computePhase,
  isFullyMigrated,
  MICROSERVICE_MIGRATION_FULL_BONUS_POINTS,
  MICROSERVICE_MIGRATION_PROBLEM_ID,
  type Platform,
  type ProbeResult,
  resolveScorePath,
  scoreFromProbe,
} from "./scoring.js";

/**
 * Microservice Migration Battle (Phase 2 / Issue #606) の 1 min polling Lambda。
 *
 * 1. `MicroserviceMigrationScoresTable` を Scan → 登録済 (slot, registeredUrl) 行を取得
 * 2. tenant 別に group 化、`Deployments` table の GSI1 (TENANT#) を引いて当該 problemId
 *    deployment の jobId / createdAt / teamId / eventId / expiresAt を取得
 * 3. createdAt + env (degradationMinutes / legacySwitchMinutes) で phase を計算
 * 4. 各 slot 並列に `/meta` + `/score` を probe → scoring.ts で +/- points を決定
 * 5. ScoreEvent (= Deployments table の sparse EVENT 行) に source=microservice-migration で書き込み
 * 6. slot row の observation 列 (platform / lastProbeAt / lastResult / lastPoints) を upsert
 * 7. 3 slot 全 non-ec2 になったら +5000 lump-sum (source=microservice-migration-bonus) を
 *    1 度だけ発行し、`fullMigrationBonusAwarded=true` を立てる
 *
 * **`fetch` 直接呼び出しの exception**: 本 Lambda は EventBridge tick で起動する outbound
 * probe で tenant 認可フローに関与しない。`health-check-handler` と同 pattern (= scoring の
 * ための outbound HTTP)。実 fetch は `./probe.ts` に閉じ込めているので tests から差し替え可能。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const scoresTableName = (): string => getEnv("MICROSERVICE_MIGRATION_SCORES_TABLE_NAME");
const deploymentsTableName = (): string => getEnv("DEPLOYMENTS_TABLE_NAME");

const DEGRADATION_MINUTES_DEFAULT = 60;
const LEGACY_SWITCH_MINUTES_DEFAULT = 90;

function readMinutesEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface SlotRow {
  PK: string;
  SK: string;
  tenantId: string;
  slot: string;
  registeredUrl: string;
  platform?: string;
  fullMigrationBonusAwarded?: boolean;
}

interface TenantDeployment {
  jobId: string;
  problemId: string;
  teamId?: string;
  eventId?: string;
  expiresAt: number;
  createdAt: string;
  eventStartsAt?: string;
  eventEndsAt?: string;
}

/**
 * 1 tenant の microservice-migration-battle deployment 行を引く。複数 deployment があれば
 * 一番新しい (createdAt) を採用。無ければ undefined。
 *
 * deployments table の GSI1 (PK=TENANT#) で Query → in-memory で problemId filter する。
 * tenant あたり deployments は MVP-1 規模で << 10 件、Filter する Read コストは無視可能。
 */
async function findTenantDeployment(tenantId: string): Promise<TenantDeployment | undefined> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: deploymentsTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "problemId = :pid AND #status = :complete",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": `TENANT#${tenantId}`,
        ":pid": MICROSERVICE_MIGRATION_PROBLEM_ID,
        ":complete": "COMPLETE",
      },
    }),
  );
  const rows = (out.Items ?? []) as Partial<DeploymentItem>[];
  if (rows.length === 0) return undefined;
  // 一番新しい createdAt を採用
  rows.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const top = rows[0];
  if (!top?.jobId || !top.problemId || !top.createdAt) return undefined;
  return {
    jobId: top.jobId,
    problemId: top.problemId,
    teamId: top.teamId,
    eventId: top.eventId,
    expiresAt: Number(top.expiresAt ?? 0),
    createdAt: top.createdAt,
    eventStartsAt: top.eventStartsAt,
    eventEndsAt: top.eventEndsAt,
  };
}

/**
 * Slot row の observation 列を更新する (= polling Lambda 専用 attributes)。
 *
 * - platform / lastProbeAt / lastResult / lastPoints / lastResponseTimeMs を上書き
 * - registeredUrl / registeredAt 等は触らない (= 登録 API 専管)
 */
async function updateSlotObservation(
  pk: string,
  sk: string,
  observation: {
    platform: string;
    lastProbeAt: string;
    lastResult: "ok" | "fail" | "timeout";
    lastPoints: number;
    lastResponseTimeMs: number;
  },
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: scoresTableName(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: [
        "SET platform = :platform,",
        "lastProbeAt = :now,",
        "lastResult = :result,",
        "lastPoints = :points,",
        "lastResponseTimeMs = :rt",
      ].join(" "),
      ExpressionAttributeValues: {
        ":platform": observation.platform,
        ":now": observation.lastProbeAt,
        ":result": observation.lastResult,
        ":points": observation.lastPoints,
        ":rt": observation.lastResponseTimeMs,
      },
    }),
  );
}

/**
 * `fullMigrationBonusAwarded=true` を立てる条件付き Update。既に true ならスキップ。
 * race (= 同 invocation 内で他の slot row が先に true 化) を防ぐためにこの row だけ立てる
 * 単純設計: 「users 行の attribute」を tenant 単位の sentinel として使う。
 */
async function tryAwardFullMigrationBonus(usersPk: string, usersSk: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: scoresTableName(),
        Key: { PK: usersPk, SK: usersSk },
        UpdateExpression: "SET fullMigrationBonusAwarded = :t",
        ConditionExpression:
          "attribute_not_exists(fullMigrationBonusAwarded) OR fullMigrationBonusAwarded = :f",
        ExpressionAttributeValues: { ":t": true, ":f": false },
      }),
    );
    return true;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * 1 slot 分の probe + scoring を実行し、ScoreEvent + slot row 更新を行う。
 *
 * 戻り値: 観測 platform (= 全分離判定で集約するため)。probe 失敗時は undefined。
 */
async function processSlot(
  slotRow: SlotRow,
  deployment: TenantDeployment,
  nowIso: string,
  degradationMinutes: number,
  legacySwitchMinutes: number,
): Promise<Platform | undefined> {
  const phase = computePhase(deployment.createdAt, nowIso, degradationMinutes, legacySwitchMinutes);
  const platform = await fetchPlatform(slotRow.registeredUrl);
  const scoreObs = await probeScore(slotRow.registeredUrl, resolveScorePath(phase.legacy));
  const probe: ProbeResult = {
    ok: scoreObs.ok,
    status: scoreObs.status,
    responseTimeMs: scoreObs.responseTimeMs,
    platform,
    reason: scoreObs.reason,
  };
  const points = scoreFromProbe(probe, phase);

  const lastResult: "ok" | "fail" | "timeout" =
    probe.reason === "timeout" ? "timeout" : probe.ok ? "ok" : "fail";

  await updateSlotObservation(slotRow.PK, slotRow.SK, {
    platform: platform ?? "unknown",
    lastProbeAt: nowIso,
    lastResult,
    lastPoints: points,
    lastResponseTimeMs: probe.responseTimeMs,
  });

  // ScoreEvent (= Deployments table の sparse EVENT 行) に書き込み。best-effort。
  try {
    await writeScoreEvent(
      ddb,
      deploymentsTableName(),
      {
        jobId: deployment.jobId,
        problemId: deployment.problemId,
        teamId: deployment.teamId,
        eventId: deployment.eventId,
        expiresAt: deployment.expiresAt,
      },
      "microservice-migration",
      points,
      nowIso,
    );
  } catch (err) {
    console.warn("[microservice-migration-poller] writeScoreEvent failed", {
      jobId: deployment.jobId,
      slot: slotRow.slot,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return platform;
}

/**
 * 1 tenant の全 slot を並列に処理。3 slot 全 non-ec2 になり、かつ bonus 未発行なら
 * +5000 lump-sum を Deployments table の ScoreEvent + slot row sentinel で記録する。
 *
 * `users` slot row を bonus sentinel に使う (= 任意の slot で良いが固定する)。`users`
 * 行が無い場合は bonus を発行できない (= 3 slot 揃ってない場合と同義なので問題なし)。
 */
async function processTenant(
  tenantId: string,
  slotRows: SlotRow[],
  nowIso: string,
  degradationMinutes: number,
  legacySwitchMinutes: number,
): Promise<void> {
  const deployment = await findTenantDeployment(tenantId);
  if (!deployment) {
    console.warn("[microservice-migration-poller] no deployment found for tenant", { tenantId });
    return;
  }

  // 各 slot を並列に処理。1 slot の失敗は他の slot を巻き込まない。
  const platforms = await Promise.all(
    slotRows.map(async (row) => {
      try {
        return await processSlot(row, deployment, nowIso, degradationMinutes, legacySwitchMinutes);
      } catch (err) {
        console.warn("[microservice-migration-poller] processSlot failed", {
          tenantId,
          slot: row.slot,
          message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }),
  );

  // 全 3 slot 揃って non-ec2 達成かつ未発行のとき bonus を 1 度発行する。
  // sentinel は users slot row に立てる (= tenant 単位で 1 行に集約)。
  const usersRow = slotRows.find((r) => r.slot === "users");
  if (!usersRow) return;
  if (usersRow.fullMigrationBonusAwarded === true) return;
  if (!isFullyMigrated(platforms)) return;

  const awarded = await tryAwardFullMigrationBonus(usersRow.PK, usersRow.SK);
  if (!awarded) return; // race: 他の tick が先に発行済 → skip
  try {
    await writeScoreEvent(
      ddb,
      deploymentsTableName(),
      {
        jobId: deployment.jobId,
        problemId: deployment.problemId,
        teamId: deployment.teamId,
        eventId: deployment.eventId,
        expiresAt: deployment.expiresAt,
      },
      "microservice-migration-bonus",
      MICROSERVICE_MIGRATION_FULL_BONUS_POINTS,
      nowIso,
    );
  } catch (err) {
    console.warn("[microservice-migration-poller] bonus writeScoreEvent failed", {
      tenantId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scan MicroserviceMigrationScoresTable で登録済 (slot, registeredUrl) 行を tenant 別に集約。
 * MVP-1 規模 (3 slot × ~10 tenant = 30 行) は 1 Scan で十分。
 */
async function listSlotRowsGroupedByTenant(): Promise<Map<string, SlotRow[]>> {
  const grouped = new Map<string, SlotRow[]>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: scoresTableName(),
        FilterExpression: "attribute_exists(registeredUrl)",
        Limit: 200,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Partial<SlotRow>[];
    for (const item of items) {
      if (!item.PK || !item.SK || !item.tenantId || !item.slot || !item.registeredUrl) continue;
      const row: SlotRow = {
        PK: item.PK,
        SK: item.SK,
        tenantId: item.tenantId,
        slot: item.slot,
        registeredUrl: item.registeredUrl,
        platform: typeof item.platform === "string" ? item.platform : undefined,
        fullMigrationBonusAwarded: item.fullMigrationBonusAwarded === true,
      };
      const list = grouped.get(item.tenantId) ?? [];
      list.push(row);
      grouped.set(item.tenantId, list);
    }
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return grouped;
}

export async function handler(): Promise<void> {
  const nowIso = new Date().toISOString();
  const degradationMinutes = readMinutesEnv(
    "MICROSERVICE_MIGRATION_DEGRADATION_MINUTES",
    DEGRADATION_MINUTES_DEFAULT,
  );
  const legacySwitchMinutes = readMinutesEnv(
    "MICROSERVICE_MIGRATION_LEGACY_SWITCH_MINUTES",
    LEGACY_SWITCH_MINUTES_DEFAULT,
  );

  const grouped = await listSlotRowsGroupedByTenant();
  if (grouped.size === 0) return;

  await Promise.all(
    Array.from(grouped.entries()).map(async ([tenantId, rows]) => {
      try {
        await processTenant(tenantId, rows, nowIso, degradationMinutes, legacySwitchMinutes);
      } catch (err) {
        console.warn("[microservice-migration-poller] processTenant failed", {
          tenantId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

// Pure helpers for tests
export { findTenantDeployment, listSlotRowsGroupedByTenant, processSlot, processTenant };
