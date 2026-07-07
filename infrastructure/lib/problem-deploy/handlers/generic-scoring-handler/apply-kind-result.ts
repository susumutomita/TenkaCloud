import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { writeScoreEvent } from "../shared/score-event.js";
import type { GenericScoringSharedResources, KindResult } from "./shared.js";

/**
 * KindResult を deployment 行に書き戻す。 score 加算 / endpointsHealth 更新 / lastResult 更新 /
 * scoringState 更新 を 1 UpdateItem で atomic に行う。 続けて score event 行 (= ulid SK の sparse row)
 * を append する。
 *
 * #1244: 旧実装は UpdateItem 失敗を console.warn + return で握り潰し、 さらに writeScoreEvent
 * 失敗も warn のみで swallow していた。 結果として portal の score / timeline 不整合の温床に
 * なっていたため、 失敗は log した上で throw する (= 1 deployment の失敗は outer の
 * `processDeployment` `.catch` で他 deployment と隔離されるが、 CloudWatch には残り
 * EventBridge 次 tick で retry される)。 AGENTS.md 「モック / スタブで握り潰す fallback 禁止」
 * に整合。
 */
export async function applyKindResult(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
  nowIso: string,
): Promise<void> {
  if (!item.PK) return;
  const update = buildKindResultUpdate(result, nowIso);

  await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.deploymentsTableName,
      Key: { PK: item.PK, SK: "META" },
      UpdateExpression: update.expression,
      ExpressionAttributeValues: update.values,
    }),
  );

  // score event 行 (= 履歴 marker) を append。失敗は throw して outer
  // `processDeployment` の .catch (= 1 tick skip + warn log) に委ねる (= 次 tick で retry)。
  await appendKindScoreEvents(shared, item, result);
}

export function buildKindResultUpdate(
  result: KindResult,
  nowIso: string,
): { readonly expression: string; readonly values: Record<string, unknown> } {
  // UpdateExpression を field 存在に応じて動的に組む。常に updatedAt / lastScoredAt を更新。
  const setParts: string[] = ["lastScoredAt = :now", "updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": nowIso };
  const addScore = result.scoreDelta !== 0 ? "ADD score :pts " : "";
  if (result.scoreDelta !== 0) values[":pts"] = result.scoreDelta;
  if (result.lastResult) {
    setParts.push("lastResult = :lr");
    values[":lr"] = result.lastResult;
  }
  if (result.endpointsHealthJson !== undefined) {
    setParts.push("endpointsHealth = :health");
    values[":health"] = result.endpointsHealthJson;
  }
  // [#2422] uptime-multi の直近サイクル attack-probe snapshot。 endpointsHealth と同型で、
  // present な kind (= attackProbes 設定あり) のときだけ書く (= 他 kind / 旧行は列を持たない)。
  if (result.attackProbesJson !== undefined) {
    setParts.push("attackProbes = :attackProbes");
    values[":attackProbes"] = result.attackProbesJson;
  }
  if (result.postureJson !== undefined) {
    setParts.push("posture = :posture");
    values[":posture"] = result.postureJson;
  }
  if (result.platform !== undefined) {
    setParts.push("platform = :platform");
    values[":platform"] = result.platform;
  }
  if (result.newState !== undefined) {
    setParts.push("scoringState = :state");
    values[":state"] = JSON.stringify(result.newState);
  }
  return { expression: `${addScore}SET ${setParts.join(", ")}`, values };
}

export async function appendKindScoreEvents(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
): Promise<void> {
  if (!item.jobId || !item.problemId) return;
  const parent = {
    jobId: item.jobId,
    problemId: item.problemId,
    teamId: item.teamId,
    eventId: item.eventId,
    expiresAt: item.expiresAt ?? 0,
  };
  for (const ev of result.scoreEvents) {
    // #1244: 失敗は log + throw。 上位 (= processDeployment の .catch) で 1 deployment 単位に
    // 隔離されるので他 deployment の採点は止まらないが、 score event 抜けは CloudWatch に
    // 残り、 次 tick で同 source が再評価されたときに再書き込みされる。
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
      console.error(`[generic-scoring] score-event write failed jobId=${item.jobId}`, {
        source: ev.source,
        points: ev.points,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
