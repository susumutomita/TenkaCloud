import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import { flagMatches } from "../generic-scoring-handler/kinds/flag.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { writeScoreEvent } from "../shared/score-event.js";
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

interface EventGate {
  readonly scoringLocked: boolean;
  readonly startsAt: string | undefined;
  readonly endsAt: string | undefined;
  readonly status: string | undefined;
}

/**
 * Issue #13: Event の gate flags を read-through で取得する。 scoringLocked + startsAt + endsAt +
 * status を 1 GetItem (= 1 RCU) でまとめて読む。 不在 / error は fail-closed で 「採点不可」 扱い
 * (= old fail-open とは逆。 JAM/GameDay 前提では「採点しないより、 まずデータ取れなかったら
 * 採点を止める」 が安全側)。
 */
async function getEventGate(
  shared: ParticipantSharedResources,
  eventId: string,
): Promise<EventGate | undefined> {
  try {
    const out = await shared.ddb.send(
      new GetCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        ProjectionExpression: "scoringLocked, startsAt, endsAt, #s",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    );
    const item = out.Item as
      | {
          scoringLocked?: boolean;
          startsAt?: string;
          endsAt?: string;
          status?: string;
        }
      | undefined;
    if (!item) return undefined;
    return {
      scoringLocked: item.scoringLocked === true,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
    };
  } catch (err) {
    console.warn("[submit-flag] getEventGate failed", {
      eventId,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Issue #13: scoring gate を評価する。 順序は次のとおり (= 上から先に該当した outcome を返す):
 *   1. event 行が無い          → "scoring_not_started" (= 安全側)
 *   2. status=ENDED / ARCHIVED → "scoring_ended"
 *   3. startsAt 未設定         → "scoring_not_started"
 *   4. now < startsAt          → "scoring_not_started"
 *   5. endsAt 設定 + now > endsAt → "scoring_ended"
 *   6. scoringLocked           → "scoring_locked"
 *   7. それ以外                → undefined (= scoring active、 加点経路へ)
 */
function evaluateGate(gate: EventGate | undefined, nowMs: number): SubmitFlagOutcome | undefined {
  if (!gate) return { kind: "scoring_not_started" };
  if (gate.status === "ENDED" || gate.status === "ARCHIVED") {
    return { kind: "scoring_ended", endsAt: gate.endsAt };
  }
  if (!gate.startsAt) return { kind: "scoring_not_started" };
  const startMs = Date.parse(gate.startsAt);
  if (Number.isFinite(startMs) && nowMs < startMs) {
    return { kind: "scoring_not_started", startsAt: gate.startsAt };
  }
  if (gate.endsAt) {
    const endMs = Date.parse(gate.endsAt);
    if (Number.isFinite(endMs) && nowMs > endMs) {
      return { kind: "scoring_ended", endsAt: gate.endsAt };
    }
  }
  if (gate.scoringLocked) return { kind: "scoring_locked" };
  return undefined;
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

  // Issue #13 / scoring gate: 競技開始前 / 終了後 / lock 時は加点経路を返さない
  // (= 提出履歴は残さず、 該当 outcome を UI に伝える)。 Event GET は 1 RCU、 submit-flag は
  // per-attempt の rare path なので read-through で十分。 旧来 (#558) は scoringLocked
  // のみ checked。 本 PR で startsAt / endsAt / status も追加し、 competition gate を完全化。
  if (typeof item.eventId === "string" && item.eventId.length > 0) {
    const gate = await getEventGate(shared, item.eventId);
    const blocked = evaluateGate(gate, Date.now());
    if (blocked) return blocked;
  }

  const scoring = scoringMap[item.problemId];
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  if (item.flagSubmitted === true) {
    return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
  }

  const outputs = parseStackOutputs(item.stackOutputs);
  const expected = outputs[scoring.flagOutputKey];
  if (typeof expected !== "string") return { kind: "no_outputs" };

  if (!flagMatches(submittedFlag, expected)) {
    // Issue #817: wrongAnswerPenalty が設定されていれば不正解時に score を減算 + wrongAnswerCount を ADD。
    // - penalty が 0 / 未設定なら旧挙動 (= UpdateItem 発火せず、 scoreDelta=0、 score 変化なし) を維持
    //   (= Free Tier 1 WCU/sec の DynamoDbLowCapacity 制約下で不要 write を出さない)
    // - penalty > 0 なら conditional Update (flagSubmitted ≠ true 一致時のみ) で減点 + count
    // - score は出口で 0 未満を clamp (= UI 期待を守る、 内部値の clamp は別 PR)
    const penalty = scoring.wrongAnswerPenalty ?? 0;
    if (penalty === 0) {
      // 旧来挙動互換: UI 用に scoreDelta=0、 score / wrongCount は現状値 fallback。
      return {
        kind: "wrong",
        scoreDelta: 0,
        totalScore: Math.max(0, Number(item.score ?? 0)),
        wrongCount: Number(item.wrongAnswerCount ?? 0),
      };
    }
    const wrongNow = new Date().toISOString();
    try {
      const updated = await shared.ddb.send(
        new UpdateCommand({
          TableName: shared.tableName,
          Key: { PK: item.PK, SK: "META" },
          UpdateExpression: "ADD wrongAnswerCount :one, score :neg SET updatedAt = :now",
          // race / 正解済との同時提出を防ぐ: flagSubmitted は false / 未設定のみ減点。
          ConditionExpression: "attribute_not_exists(flagSubmitted) OR flagSubmitted = :false",
          ExpressionAttributeValues: {
            ":one": 1,
            ":neg": -penalty,
            ":false": false,
            ":now": wrongNow,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      const attrs = updated.Attributes as
        | { score?: unknown; wrongAnswerCount?: unknown }
        | undefined;
      const rawScore = Number(attrs?.score ?? 0);
      const totalScore = rawScore < 0 ? 0 : rawScore;
      const wrongCount = Number(attrs?.wrongAnswerCount ?? 1);
      if (item.jobId) {
        // 不正解 audit event は score delta=-penalty で score_event に追記する (= 正解の "flag" と
        // 対称な "flag-wrong" として lock-out UI / 監査の証跡に使う)。
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
          "flag-wrong",
          -penalty,
          wrongNow,
        );
      }
      return { kind: "wrong", scoreDelta: -penalty, totalScore, wrongCount };
    } catch (err) {
      // flagSubmitted=true との race (= 正解と不正解が同時) は wrong 扱いを諦めて already_scored を返す。
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return { kind: "already_scored", totalScore: Number(item.score ?? 0) };
      }
      throw err;
    }
  }

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
    // 既存の event 行が記録済みなので二重に書かない。
    // #745: 旧実装は Put 失敗を console.warn で握り潰していたが、 score events 履歴が空のまま
    // header の score だけ加点される矛盾を生んだ (= IAM 不足で silent skip)。 AGENTS.md
    // 「モック / スタブで握り潰す fallback 禁止」 違反だったので、 失敗は throw して
    // route-helpers の internal_error 経路で 500 を返す。
    if (item.jobId) {
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
    }

    return { kind: "ok", scoreDelta: scoring.points, totalScore };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return { kind: "already_scored", totalScore: Number(item.score ?? 0) + scoring.points };
    }
    throw err;
  }
}
