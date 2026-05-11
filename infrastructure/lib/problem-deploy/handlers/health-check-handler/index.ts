import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
const eventsTableName = (): string => getEnv("EVENTS_TABLE_NAME");

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

/**
 * #557 / #539: Event status の auto-transition 判定 (pure function、test-friendly)。
 *
 * - `DEPLOYING`: 子 deployment が **全て terminal** (`COMPLETE` / `FAILED`) → `READY`。
 *   1 件でも進行中 (`PENDING` / `IN_PROGRESS`) があれば `undefined` (= 触らない)。
 * - `TEARDOWN`: 子 deployment が **全て終端** (`DELETED` / `FAILED`) → `ARCHIVED`。
 *   `DELETING` が残っていれば `undefined`。
 * - 子 deployment 0 件: `undefined` (= bulk-deploy/bulk-delete 前の race state、触らない)。
 * - その他 status (`DRAFT` / `READY` / `ENDED` / `ARCHIVED`): caller でフィルタ済前提だが
 *   defense-in-depth で `undefined`。
 *
 * `FAILED` を terminal に含む理由: deploy が失敗した行も「これ以上進行しない」状態なので
 * Event 全体としては前進可能 (= operator 視点で再実行 or skip 判断)。同様に teardown 失敗も
 * 引きずらない (= 最終手段は operator 手動削除)。
 */
export function resolveEventStatusTransition(
  eventStatus: string,
  deploymentStatuses: readonly string[],
): "READY" | "ARCHIVED" | undefined {
  if (deploymentStatuses.length === 0) return undefined;
  if (eventStatus === "DEPLOYING") {
    const allTerminal = deploymentStatuses.every((s) => s === "COMPLETE" || s === "FAILED");
    return allTerminal ? "READY" : undefined;
  }
  if (eventStatus === "TEARDOWN") {
    const allDone = deploymentStatuses.every((s) => s === "DELETED" || s === "FAILED");
    return allDone ? "ARCHIVED" : undefined;
  }
  return undefined;
}

/**
 * Events table を scan して `DEPLOYING` / `TEARDOWN` 状態の Event について、
 * 子 deployment 集約 status を見て `READY` / `ARCHIVED` に遷移させる (#557 #539)。
 *
 * 各 Event の判定は **並列**: 1 件遅い tenant が他を block しない。Update が CCF
 * (= operator 手動遷移などの race) で失敗した行は silent skip (= 次の tick で再評価)。
 *
 * Scan limit 100: TenkaCloud MVP 規模 (events ~10 件 / tenant、~5 tenants) で 1 tick で
 * 全件処理できる範囲。Phase 2+ で増えたら GSI3 (PK=STATUS) で query 化を検討。
 */
export async function reconcileEventStatuses(nowIso: string): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: eventsTableName(),
        ProjectionExpression: "PK, tenantId, eventId, #status",
        ExpressionAttributeNames: { "#status": "status" },
        FilterExpression: "#status = :deploying OR #status = :teardown",
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":teardown": "TEARDOWN",
        },
        Limit: 100,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (out.Items ?? []) as Array<{
      PK?: string;
      tenantId?: string;
      eventId?: string;
      status?: string;
    }>;

    await Promise.all(
      items.map(async (event) => {
        if (!event.tenantId || !event.eventId || !event.status || !event.PK) return;
        // 子 deployments を GSI1 (TENANT#) で query → 同 event のものに in-memory filter。
        const depsOut = await ddb.send(
          new QueryCommand({
            TableName: tableName(),
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :pk",
            FilterExpression: "eventId = :ev",
            ProjectionExpression: "#status",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pk": `TENANT#${event.tenantId}`,
              ":ev": event.eventId,
            },
          }),
        );
        const depStatuses = (depsOut.Items ?? [])
          .map((d) => String((d as { status?: string }).status ?? ""))
          .filter((s) => s.length > 0);
        const next = resolveEventStatusTransition(event.status, depStatuses);
        if (!next) return;

        try {
          await ddb.send(
            new UpdateCommand({
              TableName: eventsTableName(),
              Key: { PK: event.PK, SK: "META" },
              UpdateExpression: "SET #status = :next, updatedAt = :now",
              // race 防止: 期待 current status と一致しているときのみ更新 (= operator が
              // 手動 archive / 再 deploy で先に動かしてたら CCF で skip)。
              ConditionExpression: "tenantId = :tenant AND #status = :current",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":tenant": event.tenantId,
                ":current": event.status,
                ":next": next,
                ":now": nowIso,
              },
            }),
          );
          console.log("[health-check] Event status auto-transition", {
            eventId: event.eventId,
            from: event.status,
            to: next,
          });
        } catch (err) {
          const code = (err as { name?: string })?.name ?? "";
          if (code === "ConditionalCheckFailedException") return;
          console.warn("[health-check] Event status update failed", {
            eventId: event.eventId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    exclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
}

export async function handler(): Promise<void> {
  const scoringMap = parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING);
  const nowIso = new Date().toISOString();

  // Event 状態 reconcile (#557 #539) と uptime 採点を並列実行。互いに依存なし、
  // 別 table / 別 row を触るので race も無い。reconcile 失敗が scoring を巻き込まない
  // よう catch して log に残す (1 tick の失敗は次 tick で再評価される)。
  const reconcilePromise = reconcileEventStatuses(nowIso).catch((err) => {
    console.warn("[health-check] reconcileEventStatuses failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

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

  // reconcile を最後に await して invocation 終了前に確実に完了させる
  // (= Lambda が return すると未完了 Promise が中断される)。
  await reconcilePromise;
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
