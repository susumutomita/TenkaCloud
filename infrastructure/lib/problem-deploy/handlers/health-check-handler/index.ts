import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";

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
  const probes: Promise<boolean>[] = [];
  for (const e of scoring.endpoints) {
    const base = outputs[e.outputKey];
    if (!base) continue;
    probes.push(probe(joinUrl(base, e.path), e.expectStatus));
  }
  if (probes.length === 0) return;

  const allOk = (await Promise.all(probes)).every((ok) => ok);
  const now = new Date().toISOString();
  await ddb.send(buildHealthUpdate(item.PK, allOk, scoring.pointsPerSuccess, now));
}

/** 成功 / 失敗で UpdateCommand の expression が分岐するが、Key と timestamp は共通。 */
function buildHealthUpdate(
  pk: string,
  allOk: boolean,
  pointsPerSuccess: number,
  now: string,
): UpdateCommand {
  if (allOk) {
    return new UpdateCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: "META" },
      UpdateExpression:
        "ADD score :pts SET lastScoredAt = :now, lastResult = :ok, updatedAt = :now",
      ExpressionAttributeValues: { ":pts": pointsPerSuccess, ":now": now, ":ok": "ok" },
    });
  }
  return new UpdateCommand({
    TableName: tableName(),
    Key: { PK: pk, SK: "META" },
    UpdateExpression: "SET lastScoredAt = :now, lastResult = :fail, updatedAt = :now",
    ExpressionAttributeValues: { ":now": now, ":fail": "fail" },
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

    // 全 deployment を **並列** に check する。Lambda timeout 2 min 内に収まるよう、
    // sequential だと N × PROBE_TIMEOUT_MS で容易に超過する。1 deployment 失敗が
    // 他に波及しないよう catch して log に残す。
    await Promise.all(
      items.map(async (item) => {
        const scoring = item.problemId ? scoringMap[item.problemId] : undefined;
        if (scoring?.kind !== "uptime") return;
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
