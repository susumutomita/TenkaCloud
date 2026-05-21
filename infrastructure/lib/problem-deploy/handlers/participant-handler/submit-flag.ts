import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  FlagScoringMetadata,
  ProblemScoringMetadata,
} from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { flagMatches } from "../generic-scoring-handler/kinds/flag.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { evaluateGate, getEventGate } from "./event-gate.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

export type SubmitFlagOutcome =
  | { kind: "ok"; scoreDelta: number; totalScore: number }
  | { kind: "already_scored"; totalScore: number }
  /**
   * Issue #817: 不正解。 wrongAnswerPenalty が問題 metadata で正の整数で設定されていれば
   * score を減算する (= brute-force 対策、 team score は 0 で clamp)。 旧来の wrong (= 0 pt) は
   * `scoreDelta: 0, totalScore: <変化なし>` で互換維持。
   */
  | { kind: "wrong"; scoreDelta: number; totalScore: number; wrongCount: number }
  | { kind: "not_flag_problem" }
  | { kind: "no_outputs" }
  | { kind: "scoring_locked" }
  /**
   * Issue #13 / scoring gate: 競技が開始前 (= Event.startsAt 未設定 / now < startsAt) または
   * 終了後 (= now > endsAt) / status=ENDED|ARCHIVED の状態で flag 提出を受けない。
   * 旧コードはこの gate が欠落しており、 deploy 直後から flag 提出で得点が入っていた (= JAM/GameDay
   * 前提違反、 大会の公平性を完全に壊す)。
   */
  | { kind: "scoring_not_started"; startsAt?: string }
  | { kind: "scoring_ended"; endsAt?: string }
  | { kind: "unauthorized" };

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
  if (!isSubmitFlagItem(item)) return { kind: "unauthorized" };

  // Issue #13 / scoring gate: 競技開始前 / 終了後 / lock 時は加点経路を返さない
  // (= 提出履歴は残さず、 該当 outcome を UI に伝える)。 Event GET は 1 RCU、 submit-flag は
  // per-attempt の rare path なので read-through で十分。 旧来 (#558) は scoringLocked
  // のみ checked。 本 PR で startsAt / endsAt / status も追加し、 competition gate を完全化。
  const blocked = await getFlagGateBlock(shared, item);
  if (blocked) return blocked;

  const scoring = scoringMap[item.problemId];
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  if (item.flagSubmitted === true) {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }

  const outputs = parseStackOutputs(item.stackOutputs);
  const expected = outputs[scoring.flagOutputKey];
  if (typeof expected !== "string") return { kind: "no_outputs" };

  if (!flagMatches(submittedFlag, expected)) {
    return scoreWrongFlag(shared, item, scoring);
  }

  return scoreCorrectFlag(shared, item, scoring);
}

function isSubmitFlagItem(
  item: Partial<DeploymentItem> | undefined,
): item is Partial<DeploymentItem> & { PK: string; problemId: string } {
  return typeof item?.PK === "string" && typeof item.problemId === "string";
}

async function getFlagGateBlock(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem>,
): Promise<SubmitFlagOutcome | undefined> {
  if (typeof item.eventId !== "string" || item.eventId.length === 0) return undefined;
  const gate = await getEventGate(shared, item.eventId);
  return evaluateGate(gate, Date.now());
}

async function scoreWrongFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  scoring: FlagScoringMetadata,
): Promise<SubmitFlagOutcome> {
  const penalty = scoring.wrongAnswerPenalty ?? 0;
  if (penalty === 0) return legacyWrongFlagOutcome(item);
  const wrongNow = new Date().toISOString();
  try {
    const wrong = await updateWrongFlag(shared, item.PK, penalty, wrongNow);
    if (item.jobId) await writeFlagScoreEvent(shared, item, "flag-wrong", -penalty, wrongNow);
    return { kind: "wrong", scoreDelta: -penalty, ...wrong };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
    }
    throw err;
  }
}

function legacyWrongFlagOutcome(item: Partial<DeploymentItem>): SubmitFlagOutcome {
  return {
    kind: "wrong",
    scoreDelta: 0,
    totalScore: Math.max(0, Number(item.score ?? 0)),
    wrongCount: Number(item.wrongAnswerCount ?? 0),
  };
}

async function updateWrongFlag(
  shared: ParticipantSharedResources,
  PK: string,
  penalty: number,
  now: string,
): Promise<{ readonly totalScore: number; readonly wrongCount: number }> {
  const updated = await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.tableName,
      Key: { PK, SK: "META" },
      UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
      ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
      ExpressionAttributeValues: { ":one": 1, ":neg": -penalty, ":false": false, ":now": now },
      ReturnValues: "ALL_NEW",
    }),
  );
  const attrs = updated.Attributes as { score?: unknown; wrongAnswerCount?: unknown } | undefined;
  const rawScore = Number(attrs?.score ?? 0);
  return {
    totalScore: rawScore < 0 ? 0 : rawScore,
    wrongCount: Number(attrs?.wrongAnswerCount ?? 1),
  };
}

async function scoreCorrectFlag(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  scoring: FlagScoringMetadata,
): Promise<SubmitFlagOutcome> {
  // ConditionExpression で flagSubmitted=true への 2 重加算を防ぐ。レース勝者だけが加点される。
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
    // 既存の event 行が記録済みなので二重に書かない。
    // #745: 旧実装は Put 失敗を console.warn で握り潰していたが、 score events 履歴が空のまま
    // header の score だけ加点される矛盾を生んだ (= IAM 不足で silent skip)。 AGENTS.md
    // 「モック / スタブで握り潰す fallback 禁止」 違反だったので、 失敗は throw して
    // route-helpers の internal_error 経路で 500 を返す。
    if (item.jobId) await writeFlagScoreEvent(shared, item, "flag", scoring.points, now);

    return { kind: "ok", scoreDelta: scoring.points, totalScore };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { kind: "already_scored", totalScore: Number(item.score ?? 0) + scoring.points };
    }
    throw err;
  }
}

function writeFlagScoreEvent(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { problemId: string; jobId?: string },
  source: "flag" | "flag-wrong",
  points: number,
  occurredAt: string,
): Promise<void> {
  return writeScoreEvent(
    shared.ddb,
    shared.tableName,
    {
      jobId: String(item.jobId ?? ""),
      problemId: item.problemId,
      teamId: item.teamId,
      eventId: item.eventId,
      expiresAt: item.expiresAt ?? 0,
    },
    source,
    points,
    occurredAt,
  );
}
