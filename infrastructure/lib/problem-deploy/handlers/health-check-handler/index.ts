import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";

/**
 * EventBridge Scheduler `rate(1 minute)` で起動される Lambda。
 *
 * 各 status=COMPLETE な deployment について、metadata の `scoring` が `uptime` 形式
 * なら declared endpoints を probe し、すべて 2xx (or expectStatus) ならスコア加点。
 * 失敗時は score 加点せず lastResult=fail のみ更新する。
 *
 * MVP-1 は scan + filter (= 1 RCU 内に収まる規模)。Phase 2 で 100+ deployments に
 * なったら GSI3 (PK=STATUS#COMPLETE) を追加して query 化する。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// 遅延 lookup: module load 時に env が無い (= test 環境) でも import がコケない。
// Lambda runtime では handler 呼び出し時に env は確実にあるので問題なし。
function getTableName(): string {
  return getEnv("DEPLOYMENTS_TABLE_NAME");
}

interface UptimeScoringConfig {
  kind: "uptime";
  endpoints: { outputKey: string; path: string; expectStatus: number[] }[];
  pointsPerSuccess: number;
}

function parseScoringMap(): Record<string, unknown> {
  const raw = process.env.BATTLE_PROBLEMS_SCORING ?? "";
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function asUptimeScoring(value: unknown): UptimeScoringConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind !== "uptime") return undefined;
  const u = value as { endpoints?: unknown; pointsPerSuccess?: unknown };
  if (!Array.isArray(u.endpoints) || typeof u.pointsPerSuccess !== "number") return undefined;
  return value as UptimeScoringConfig;
}

const PROBE_TIMEOUT_MS = 8_000;

async function probe(url: string, expectStatus: number[]): Promise<boolean> {
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

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`;
  return base + path;
}

async function checkOne(
  item: Partial<DeploymentItem>,
  scoring: UptimeScoringConfig,
): Promise<void> {
  if (!item.PK) return;
  const outputs = parseStackOutputs(item.stackOutputs);
  const probes = scoring.endpoints
    .map((e) => {
      const base = outputs[e.outputKey];
      if (!base) return undefined;
      return probe(joinUrl(base, e.path), e.expectStatus);
    })
    .filter((p): p is Promise<boolean> => p !== undefined);

  if (probes.length === 0) return;

  const results = await Promise.all(probes);
  const allOk = results.every((ok) => ok);
  const now = new Date().toISOString();

  if (allOk) {
    await ddb.send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression:
          "ADD score :pts SET lastScoredAt = :now, lastResult = :ok, updatedAt = :now",
        ExpressionAttributeValues: {
          ":pts": scoring.pointsPerSuccess,
          ":now": now,
          ":ok": "ok",
        },
      }),
    );
  } else {
    await ddb.send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression: "SET lastScoredAt = :now, lastResult = :fail, updatedAt = :now",
        ExpressionAttributeValues: { ":now": now, ":fail": "fail" },
      }),
    );
  }
}

export async function handler(): Promise<void> {
  const scoringMap = parseScoringMap();

  // MVP-1 規模 (= ~50 deployments) は Scan + FilterExpression で十分。Phase 2 で
  // 100+ になったら GSI3 (PK=STATUS#{status}) を追加して Query 化する。
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "#status = :complete",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":complete": "COMPLETE" },
        Limit: 200,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Partial<DeploymentItem>[];
    for (const item of items) {
      const scoring = item.problemId ? asUptimeScoring(scoringMap[item.problemId]) : undefined;
      if (!scoring) continue;
      try {
        await checkOne(item, scoring);
      } catch (err) {
        console.warn(`[health-check] failed for jobId=${item.jobId}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}

export { asUptimeScoring, joinUrl, parseScoringMap };
