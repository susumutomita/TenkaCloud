import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import type { ParticipantSharedResources } from "./shared.js";

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  | { kind: "wrong" }
  | { kind: "not_flag_problem" }
  | { kind: "no_outputs" }
  | { kind: "unauthorized" };

interface ScoringFlagConfig {
  kind: "flag";
  flagOutputKey: string;
  points: number;
}

/**
 * env `BATTLE_PROBLEMS_SCORING` から `{ [problemId]: scoring }` を decode する。
 * 不正 / 欠損は空 map を返す (= 全 problemId が not_flag_problem になる、安全側)。
 */
export function parseProblemsScoring(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  return {};
}

function isFlagConfig(value: unknown): value is ScoringFlagConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown; flagOutputKey?: unknown; points?: unknown };
  return (
    v.kind === "flag" &&
    typeof v.flagOutputKey === "string" &&
    typeof v.points === "number" &&
    Number.isFinite(v.points) &&
    v.points > 0
  );
}

/** 競技者 input と stack output 値を比較。両端 trim、case-sensitive。 */
function flagMatches(submitted: string, expected: string): boolean {
  return submitted.trim() === expected.trim();
}

/**
 * teamLoginKey で deployment 行を引き、flag を採点する。正解なら `ADD score :pts`
 * + `SET flagSubmitted = true` を 1 UpdateItem で atomic に行う。
 *
 * - kind=flag 以外の問題は `not_flag_problem`
 * - stackOutputs に flagOutputKey が無い (= deploy 未完了等) は `no_outputs`
 * - 既に flagSubmitted=true なら `already_scored` (= 重複加算しない)
 */
export async function submitFlag(
  shared: ParticipantSharedResources,
  scoringMap: Record<string, unknown>,
  teamLoginKey: string,
  submittedFlag: string,
): Promise<SubmitFlagOutcome> {
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${teamLoginKey}` },
      Limit: 1,
    }),
  );
  const item = (out.Items?.[0] ?? undefined) as Partial<DeploymentItem> | undefined;
  if (!item?.PK || !item.problemId) return { kind: "unauthorized" };

  const scoring = scoringMap[item.problemId];
  if (!isFlagConfig(scoring)) return { kind: "not_flag_problem" };

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
