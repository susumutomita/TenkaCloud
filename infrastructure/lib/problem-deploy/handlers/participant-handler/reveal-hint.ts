import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ProblemScoringMetadata } from "../../../utils/scoring-metadata.js";
import { parseHintRevealedAttribute } from "../shared/hint-reveal.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { evaluateGate, getEventGate } from "./event-gate.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * Issue #742 Phase 3: progressive hint reveal API。
 *
 * 流れ:
 *   1. teamLoginKey で team の全 deployment 行を引き、 problemId 一致行を抽出
 *   2. scoringMap から hints array を取得、 hintId 一致 hint を見つける
 *   3. DDB UpdateItem で **conditional** に hintsRevealed を append + score を deduct
 *      - 条件: 同 hintId が既に hintsRevealed に居ない
 *      - 条件 fail = 既に reveal 済 → idempotent な already_revealed outcome を返す
 *   4. 成功時 content + 新 score を返す
 *
 * Phase 2 で導入した `HintRevealRecord` shape (= hintId / revealedAt /
 * penaltyApplied) を DDB list append する。 同 hintId 重複は ConditionExpression で
 * 防ぐ (= API は idempotent で、 何度叩いても score は 1 度だけ deduct)。
 */
export type RevealHintOutcome =
  | { kind: "ok"; content: string; penaltyApplied: number; totalScore: number; revealedAt: string }
  | { kind: "already_revealed"; content: string; penaltyApplied: number; totalScore: number }
  | { kind: "unauthorized" }
  | { kind: "not_flag_problem" }
  | { kind: "unknown_hint" }
  /**
   * Issue #1005: 競技開始前 / 終了後 / scoringLocked 状態でヒント開封を block する。
   * submit-flag と同じ gate を共有 (event-gate.ts)。 旧来 reveal-hint は gate を見ず、
   * 開始前に開けて -penalty が accrue する公平性破壊バグがあった。
   */
  | { kind: "scoring_not_started"; startsAt?: string }
  | { kind: "scoring_ended"; endsAt?: string }
  | { kind: "scoring_locked" };

export async function revealHint(
  shared: ParticipantSharedResources,
  scoringMap: Record<string, ProblemScoringMetadata>,
  teamLoginKey: string,
  problemId: string,
  hintId: string,
): Promise<RevealHintOutcome> {
  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const item = items.find((i) => i.problemId === problemId);
  if (!item?.PK || !item.problemId) return { kind: "unauthorized" };

  // Issue #1005: ヒント開封も submit-flag と同じ scoring gate を通す。
  // 開始前 / 終了後 / scoringLocked では penalty を accrue させない (= 公平性)。
  if (typeof item.eventId === "string" && item.eventId.length > 0) {
    const gate = await getEventGate(shared, item.eventId);
    const blocked = evaluateGate(gate, Date.now());
    if (blocked) return blocked;
  }

  const scoring = scoringMap[item.problemId];
  // Phase 3 は flag kind 限定で hints をサポート (= Phase 5 で他 4 kind に拡張)。
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  const hint = scoring.hints?.find((h) => h.id === hintId);
  if (!hint) return { kind: "unknown_hint" };

  // 既に reveal 済か read-through で先に check (= UI の 「locked → unlocked」 UX で同 hint を
  // 1 click で reveal、 2 度目は no-op で content + score を返す)。
  const alreadyRevealed = parseHintRevealedAttribute(item.hintsRevealed);
  const existing = alreadyRevealed.find((r) => r.hintId === hintId);
  if (existing) {
    return {
      kind: "already_revealed",
      content: hint.content,
      penaltyApplied: existing.penaltyApplied,
      totalScore: Number(item.score ?? 0),
    };
  }

  const now = new Date().toISOString();
  const record = { hintId: hint.id, revealedAt: now, penaltyApplied: hint.penalty };

  // ConditionExpression で同 hintId が既に居る場合の race を block。 hintsRevealed が
  // 未存在 (= attribute 不在) でも attribute_not_exists で通すように OR 結合する。
  // list_append で既存配列に append、 if_not_exists で 「初回 reveal なら新規空配列」
  // フォールバックを噛ませる。
  // score は ADD で -penalty を加算 (= 負数 ADD で減算)。 penalty=0 のときは 0 ADD で no-op。
  try {
    const updated = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.tableName,
        Key: { PK: item.PK, SK: "META" },
        UpdateExpression:
          "SET hintsRevealed = list_append(if_not_exists(hintsRevealed, :empty), :record), updatedAt = :now " +
          "ADD score :neg",
        ConditionExpression:
          "attribute_not_exists(hintsRevealed) OR NOT contains(hintsRevealed, :recordForContains)",
        ExpressionAttributeValues: {
          ":empty": [],
          ":record": [record],
          // `contains` は list の要素を文字列でも sub-object でも比較可能。 ただし DDB の
          // contains は equality 比較なので、 同じ hintId でも revealedAt / penaltyApplied が
          // 違うと別物扱いになる。 これは race condition で安全側 (= 二重 reveal が新 record で
          // 防げる)、 ただし完全な idempotency は読み戻しで保証する。
          ":recordForContains": record,
          ":now": now,
          // hint.penalty=0 のとき `-0` を生成しないよう、 0 のときは 0 をそのまま渡す
          // (= `Object.is(-0, 0)` は false なので test / JSON で混乱しないため)。
          ":neg": hint.penalty === 0 ? 0 : -hint.penalty,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const totalScore = Number((updated.Attributes as { score?: unknown })?.score ?? -hint.penalty);

    // Issue #1038 P1 #8: hint 開封の score event を履歴に書く (= 旧来 score だけ ADD して
    // score event 行を作らず、 portal の Score events ページが「-30pt なのに履歴 0 件」 と
    // 表示する不整合を起こしていた)。 best-effort で書き、 失敗時は log のみ (= 親 score
    // の整合性は ADD で既に成立、 履歴の loss だけ受容、 既存 writeScoreEvent と同方針)。
    if (hint.penalty !== 0) {
      try {
        await writeScoreEvent(
          shared.ddb,
          shared.tableName,
          {
            jobId: String(item.jobId ?? ""),
            problemId: item.problemId,
            ...(typeof item.teamId === "string" ? { teamId: item.teamId } : {}),
            ...(typeof item.eventId === "string" ? { eventId: item.eventId } : {}),
            expiresAt: Number(item.expiresAt ?? 0),
          },
          "hint",
          -hint.penalty,
          now,
        );
      } catch (err) {
        console.warn("[reveal-hint] writeScoreEvent failed (best-effort)", {
          jobId: item.jobId,
          hintId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      kind: "ok",
      content: hint.content,
      penaltyApplied: hint.penalty,
      totalScore,
      revealedAt: now,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      // Race: 同 hintId が他経路で既に append された。 already_revealed として返す。
      return {
        kind: "already_revealed",
        content: hint.content,
        penaltyApplied: hint.penalty,
        totalScore: Number(item.score ?? 0),
      };
    }
    throw err;
  }
}
