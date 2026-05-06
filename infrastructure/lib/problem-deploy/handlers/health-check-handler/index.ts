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

/**
 * 1 endpoint の最近のヘルス状態。`since` は ok=false が連続している開始時刻 (= 攻撃検知
 * 起点)。Battle 防御側が「ApiUrl が 3 分前から落ちてる」を画面で見るためのフィールド。
 */
export interface EndpointHealth {
  ok: boolean;
  checkedAt: string;
  /** ok=false のとき、現状態が始まった時刻。ok=true ならフィールド自体省略。 */
  since?: string;
}

export function parseEndpointsHealth(raw: string | undefined): Record<string, EndpointHealth> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, EndpointHealth> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as { ok?: unknown; checkedAt?: unknown; since?: unknown };
    if (typeof e.ok !== "boolean" || typeof e.checkedAt !== "string") continue;
    out[k] = {
      ok: e.ok,
      checkedAt: e.checkedAt,
      since: typeof e.since === "string" ? e.since : undefined,
    };
  }
  return out;
}

async function checkOne(item: Partial<DeploymentItem>, scoring: UptimeScoring): Promise<void> {
  if (!item.PK) return;
  const outputs = parseStackOutputs(item.stackOutputs);

  // outputKey → probe Promise を順序保証付きで構築。空 base (= stackOutputs に該当 key
  // 不在) は skip し、map から外す。
  const probeJobs: { outputKey: string; promise: Promise<boolean> }[] = [];
  for (const e of scoring.endpoints) {
    const base = outputs[e.outputKey];
    if (!base) continue;
    probeJobs.push({
      outputKey: e.outputKey,
      promise: probe(joinUrl(base, e.path), e.expectStatus),
    });
  }
  if (probeJobs.length === 0) return;

  const results = await Promise.all(probeJobs.map((p) => p.promise));
  const now = new Date().toISOString();
  const prevHealth = parseEndpointsHealth(item.endpointsHealth);
  const newHealth: Record<string, EndpointHealth> = {};
  let allOk = true;
  for (let i = 0; i < probeJobs.length; i++) {
    const job = probeJobs[i];
    const ok = results[i] ?? false;
    if (!job) continue;
    if (!ok) allOk = false;
    const prev = prevHealth[job.outputKey];
    // ok=false が継続中なら `since` を保持、ok→fail 遷移なら `since=now`、ok=true なら省略。
    const since = ok ? undefined : prev && !prev.ok && prev.since ? prev.since : now;
    newHealth[job.outputKey] = { ok, checkedAt: now, ...(since ? { since } : {}) };
  }

  await ddb.send(buildHealthUpdate(item.PK, allOk, scoring.pointsPerSuccess, now, newHealth));
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
