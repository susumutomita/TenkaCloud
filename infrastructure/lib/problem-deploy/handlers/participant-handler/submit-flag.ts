import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  | { kind: "wrong" }
  | { kind: "not_flag_problem" }
  | { kind: "no_outputs" }
  | { kind: "unauthorized" };

/** 競技者 input と stack output 値を比較。両端 trim、case-sensitive。 */
function flagMatches(submitted: string, expected: string): boolean {
  return submitted.trim() === expected.trim();
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
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const totalScore = Number((updated.Attributes as { score?: unknown })?.score ?? scoring.points);
    return { kind: "ok", scoreDelta: scoring.points, totalScore };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { kind: "already_scored", totalScore: Number(item.score ?? 0) + scoring.points };
    }
    throw err;
  }
}
