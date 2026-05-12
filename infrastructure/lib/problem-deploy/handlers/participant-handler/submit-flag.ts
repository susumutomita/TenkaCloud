import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import { flagMatches } from "../generic-scoring-handler/kinds/flag.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  | { kind: "wrong" }
  | { kind: "not_flag_problem" }
  | { kind: "no_outputs" }
  | { kind: "scoring_locked" }
  | { kind: "unauthorized" };

/**
 * #558: Event の scoringLocked flag を read-through で取得する。
 * - 行不在 / フィールド無し → false (= unlocked と同義)
 * - error → false (fail-open。lock が効かない方が「採点ストップ」より運用上マシ、健全な状態に戻る)
 */
async function isEventScoringLocked(
  shared: ParticipantSharedResources,
  eventId: string,
): Promise<boolean> {
  try {
    const out = await shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        ProjectionExpression: "scoringLocked",
      }),
    );
    return (out.Item as { scoringLocked?: boolean } | undefined)?.scoringLocked === true;
  } catch (err) {
    console.warn("[submit-flag] isEventScoringLocked failed (fail-open)", {
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * teamLoginKey で team の全 deployment 行を引き、`problemId` 一致する行に対し flag を
 * 採点する。正解なら `ADD score :pts` + `SET flagSubmitted = true` を 1 UpdateItem
 * で atomic に行う (Phase 2c: team scope なので problemId 引数が必須)。
 *
 * - team scope に該当行が無い (key 不正) は `unauthorized`
 * - team に該当 problemId が無い (= 違う event の問題を指定) は `unauthorized`
 *   (= problem の存在を漏らさない)
 * - kind=flag 以外の問題は `not_flag_problem`
 * - stackOutputs に flagOutputKey が無い (= deploy 未完了等) は `no_outputs`
 * - 既に flagSubmitted=true なら `already_scored` (= 重複加算しない)
 */
export async function submitFlag(
  shared: ParticipantSharedResources,
  scoringMap: Record<string, ProblemScoringMetadata>,
  teamLoginKey: string,
  problemId: string,
  submittedFlag: string,
): Promise<SubmitFlagOutcome> {
  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const item = items.find((i) => i.problemId === problemId);
  if (!item?.PK || !item.problemId) return { kind: "unauthorized" };

  // #558: scoring lock check — Event 単位で lock されていたら加点経路を返さない
  // (= 提出履歴は残さず、`scoring_locked` outcome で UI に伝える)。Event GET は 1 RCU、
  // submit-flag は per-attempt の rare path なので read-through で十分。
  if (typeof item.eventId === "string" && item.eventId.length > 0) {
    const locked = await isEventScoringLocked(shared, item.eventId);
    if (locked) return { kind: "scoring_locked" };
  }

  const scoring = scoringMap[item.problemId];
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  if (item.flagSubmitted === true) {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }

  const outputs = parseStackOutputs(item.stackOutputs);
  const expected = outputs[scoring.flagOutputKey];
  if (typeof expected !== "string") return { kind: "no_outputs" };

  if (!flagMatches(submittedFlag, expected)) return { kind: "wrong" };

  // ConditionExpression で flagSubmitted=true への 2 重加算を防ぐ。レース勝者だけが
  // 加点される。
  const now = new Date().toISOString();
  try {
    const updated = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression:
          "ADD score :pts SET flagSubmitted = :true, lastScoredAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
        ExpressionAttributeValues: {
          ":pts": scoring.points,
          ":true": true,
          ":false": false,
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const totalScore = Number((updated.Attributes as { score?: unknown })?.score ?? scoring.points);

    // 加点成功時のみ score event 行を append。失敗 (= already_scored の race) では
    // 既存の event 行が記録済みなので二重に書かない。Put 失敗は best-effort で log。
    if (item.jobId) {
      try {
        await writeScoreEvent(
          shared.ddb,
          shared.tableName,
          {
            jobId: item.jobId,
            problemId: item.problemId,
            teamId: item.teamId,
            eventId: item.eventId,
            expiresAt: item.expiresAt ?? 0,
          },
          "flag",
          scoring.points,
          now,
        );
      } catch (err) {
        console.warn(`[submit-flag] score-event write failed jobId=${item.jobId}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { kind: "ok", scoreDelta: scoring.points, totalScore };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { kind: "already_scored", totalScore: Number(item.score ?? 0) + scoring.points };
    }
    throw err;
  }
}
