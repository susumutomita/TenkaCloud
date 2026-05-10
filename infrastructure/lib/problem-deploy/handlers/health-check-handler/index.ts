import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../shared/endpoints-health.js";
import { writeScoreEvent } from "../shared/score-event.js";

/**
 * EventBridge Scheduler `rate(1 minute)` で起動される Lambda。
 *
 * 各 status=COMPLETE な deployment について metadata の `scoring.kind=uptime` の
 * declared endpoints を probe し、すべて 2xx (or expectStatus) ならスコア加点、
 * 失敗時は `lastResult=fail` のみ更新する。
 *
 * MVP-1 規模 (= ~50 deployments) は Scan + FilterExpression で十分。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// 遅延 lookup: module load 時に env が無くても import がコケない (test 互換)。
const tableName = (): string => getEnv("DEPLOYMENTS_TABLE_NAME");

const PROBE_TIMEOUT_MS = 8_000;

async function probe(url: string, expectStatus: readonly number[]): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    return expectStatus.includes(res.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** `new URL(path, base)` で base + relative path を合成する。 */
function joinUrl(base: string, relPath: string): string {
  if (!relPath) return base;
  try {
    return new URL(relPath).toString();
  } catch {
    return new URL(relPath, base.endsWith("/") ? base : `${base}/`).toString();
  }
}

type UptimeScoring = Extract<ProblemScoringMetadata, { kind: "uptime" }>;

async function checkOne(item: Partial<DeploymentItem>, scoring: UptimeScoring): Promise<void> {
  if (!item.PK) return;
  const outputs = parseStackOutputs(item.stackOutputs);

  // outputKey → probe を平行発行し、結果を outputKey と組で受ける (順序保証は必要無し)。
  const probeResults = await Promise.all(
    scoring.endpoints
      .map((e) => {
        const base = outputs[e.outputKey];
        if (!base) return undefined;
        return (async () => ({
          outputKey: e.outputKey,
          ok: await probe(joinUrl(base, e.path), e.expectStatus),
        }))();
      })
      .filter((p): p is Promise<{ outputKey: string; ok: boolean }> => p !== undefined),
  );
  if (probeResults.length === 0) return;

  const now = new Date().toISOString();
  const prevHealth = parseEndpointsHealth(item.endpointsHealth);
  const newHealth: Record<string, EndpointHealth> = {};
  let allOk = true;
  for (const { outputKey, ok } of probeResults) {
    if (!ok) allOk = false;
    const since = computeSince(ok, prevHealth[outputKey], now);
    newHealth[outputKey] = { ok, checkedAt: now, ...(since ? { since } : {}) };
  }

  await ddb.send(buildHealthUpdate(item.PK, allOk, scoring.pointsPerSuccess, now, newHealth));

  // ok / fail に応じて 2 種類の score event を best-effort で書き込む。Put 失敗は log のみ
  // (= 採点 / 健全性 update は既に確定済、整合性より可用性優先)。
  //
  // - allOk = true  → "uptime" event (加点 marker、source=uptime / result=ok / points=N)
  // - allOk = false かつ 直前 tick が ok → "attack-detected" event (= 攻撃検知の遷移
  //   marker、source=attack-detected / result=down / points=0)。**連続 fail tick では
  //   書かない** (= row 爆発防止、ADR-005 D2-A の hard guard)
  if (!item.jobId || !item.problemId) return;
  const parent = {
    jobId: item.jobId,
    problemId: item.problemId,
    teamId: item.teamId,
    eventId: item.eventId,
    expiresAt: item.expiresAt ?? 0,
  };

  if (allOk) {
    try {
      await writeScoreEvent(ddb, tableName(), parent, "uptime", scoring.pointsPerSuccess, now);
    } catch (err) {
      console.warn(`[health-check] score-event write failed jobId=${item.jobId}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 直前 tick が ok だった場合のみ attack-detected を書く (= 連続 fail tick での重複
  // write を防ぐ hard guard)。`undefined` (= probe 未実行 / 旧 deployment) は ok 扱い
  // しない (= 初回 deploy 直後の誤検知を避ける)。
  if (item.lastResult === "ok") {
    try {
      await writeScoreEvent(ddb, tableName(), parent, "attack-detected", 0, now);
    } catch (err) {
      console.warn(`[health-check] attack-detected write failed jobId=${item.jobId}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 成功 / 失敗で UpdateCommand の expression が分岐するが、Key と timestamp は共通。 */
function buildHealthUpdate(
  pk: string,
  allOk: boolean,
  pointsPerSuccess: number,
  now: string,
  endpointsHealth: Record<string, EndpointHealth>,
): UpdateCommand {
  const healthJson = JSON.stringify(endpointsHealth);
  if (allOk) {
    return new UpdateCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: "META" },
      UpdateExpression:
        "ADD score :pts SET lastScoredAt = :now, lastResult = :ok, updatedAt = :now, endpointsHealth = :health",
      ExpressionAttributeValues: {
        ":pts": pointsPerSuccess,
        ":now": now,
        ":ok": "ok",
        ":health": healthJson,
      },
    });
  }
  return new UpdateCommand({
    TableName: tableName(),
    Key: { PK: pk, SK: "META" },
    UpdateExpression:
      "SET lastScoredAt = :now, lastResult = :fail, updatedAt = :now, endpointsHealth = :health",
    ExpressionAttributeValues: { ":now": now, ":fail": "fail", ":health": healthJson },
  });
}

export async function handler(): Promise<void> {
  const scoringMap = parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING);

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: tableName(),
        FilterExpression: "#status = :complete",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":complete": "COMPLETE" },
        Limit: 200,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Partial<DeploymentItem>[];

    const nowIso = new Date().toISOString();
    // 全 deployment を **並列** に check する。Lambda timeout 2 min 内に収まるよう、
    // sequential だと N × PROBE_TIMEOUT_MS で容易に超過する。1 deployment 失敗が
    // 他に波及しないよう catch して log に残す。
    await Promise.all(
      items.map(async (item) => {
        const scoring = item.problemId ? scoringMap[item.problemId] : undefined;
        if (scoring?.kind !== "uptime") return;
        // Event 開始時刻 (eventStartsAt) より前は probe + 採点を skip。
        //   - deploy 直後の意図しない加点を防ぐ (operator が「即座に開始」or 日時設定するまで停止)
        //   - 競技開始前の Lambda 呼び出し / outbound HTTP probe を抑制 (無駄なコスト削減)
        if (!isScoringActive(item, nowIso)) return;
        try {
          await checkOne(item, scoring);
        } catch (err) {
          console.warn(`[health-check] failed for jobId=${item.jobId}`, {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}

export { joinUrl };

/**
 * deployment が採点対象かを判定。`eventStartsAt` が未設定 / 未来なら false。
 * - 未設定: 旧 jobId-based deployment / Event.startsAt 未設定 → 採点無し
 * - 未来: operator が schedule 済だがまだ時刻に到達していない → skip
 * - 終了済み: `eventEndsAt` が設定されていて now >= eventEndsAt → skip (Issue #494)
 * 比較は ISO8601 文字列の辞書順比較で安全 (UTC ISO は時系列ソート可能)。
 */
export function isScoringActive(
  item: Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">,
  nowIso: string,
): boolean {
  if (typeof item.eventStartsAt !== "string") return false;
  if (nowIso < item.eventStartsAt) return false;
  if (typeof item.eventEndsAt === "string" && nowIso >= item.eventEndsAt) return false;
  return true;
}
