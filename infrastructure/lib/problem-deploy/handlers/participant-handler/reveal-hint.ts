import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ProblemScoringMetadata, ProgressiveHint } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { parseHintRevealedAttribute } from "../shared/hint-reveal.js";
import { writeScoreEvent } from "../shared/score-event.js";
import { getCompetitionAccessBlock } from "./challenge-access.js";
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
   * Issue #1315: ヒント順序制約。 Hint N は Hint 1..N-1 がすべて reveal 済のときのみ
   * 開封できる (progressive hint convention)。 違反時は missingHintId (= 次に開ける
   * べき直前 hint) を含めて 409 を返し、 UI は 「Hint N-1 を先に reveal してください」
   * の親切文言を出す。
   */
  | { kind: "hint_out_of_order"; missingHintId: string }
  /**
   * Issue #1005: 競技開始前 / 終了後 / scoringLocked 状態でヒント開封を block する。
   * submit-flag と同じ gate を共有 (event-gate.ts)。 旧来 reveal-hint は gate を見ず、
   * 開始前に開けて -penalty が accrue する公平性破壊バグがあった。
   */
  | { kind: "scoring_not_started"; startsAt?: string }
  | { kind: "scoring_ended"; endsAt?: string }
  | { kind: "scoring_locked" }
  /**
   * Issue #2283: Progression Gate 未完了。 locked challenge の hint 開封 (= penalty accrue を
   * 伴う競技操作) を server-side で拒否する。
   */
  | { kind: "challenge_prerequisite_not_met"; gateProblemId: string };

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
  if (!isRevealHintItem(item)) return { kind: "unauthorized" };

  // Issue #1005: ヒント開封も submit-flag と同じ scoring gate を通す。
  // 開始前 / 終了後 / scoringLocked では penalty を accrue させない (= 公平性)。
  // Issue #2283: 同じ判定 (getCompetitionAccessBlock) で Progression Gate も enforce する。
  const blocked = await getCompetitionAccessBlock(shared, items, item);
  if (blocked) return blocked;

  const scoring = scoringMap[item.problemId];
  // Phase 3 は flag kind 限定で hints をサポート (= Phase 5 で他 4 kind に拡張)。
  if (scoring?.kind !== "flag") return { kind: "not_flag_problem" };

  const hints = scoring.hints ?? [];
  const hintIndex = hints.findIndex((h) => h.id === hintId);
  if (hintIndex < 0) return { kind: "unknown_hint" };
  const hint = hints[hintIndex];
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

  // Issue #1315: 順序制約。 Hint N (index > 0) は Hint 1..N-1 がすべて reveal 済の
  // ときのみ開封可。 違反時は missing する 「次に開けるべき直前 hint」 の id を返す
  // (= UI で 「Hint N-1 を先に reveal」 文言を組み立てるため)。
  const missingPredecessor = findMissingPredecessor(hints, hintIndex, alreadyRevealed);
  if (missingPredecessor) {
    return { kind: "hint_out_of_order", missingHintId: missingPredecessor };
  }

  return updateHintReveal(shared, item, hint, hintId);
}

/**
 * 順序制約 enforcer。 Hint index 0 は無条件 OK。 index > 0 のとき、 index 未満の hint が
 * 1 つでも未 reveal なら最初の未 reveal hint の id を返す (= UI へのヒント)。
 * 全先行 hint が reveal 済なら undefined。
 */
function findMissingPredecessor(
  hints: readonly ProgressiveHint[],
  targetIndex: number,
  alreadyRevealed: readonly { readonly hintId: string }[],
): string | undefined {
  if (targetIndex <= 0) return undefined;
  const revealedIds = new Set(alreadyRevealed.map((r) => r.hintId));
  for (let i = 0; i < targetIndex; i++) {
    const predecessor = hints[i];
    if (predecessor && !revealedIds.has(predecessor.id)) return predecessor.id;
  }
  return undefined;
}

function isRevealHintItem(
  item: Partial<DeploymentItem> | undefined,
): item is Partial<DeploymentItem> & { PK: string; problemId: string } {
  return typeof item?.PK === "string" && typeof item.problemId === "string";
}

async function updateHintReveal(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { PK: string; problemId: string },
  hint: ProgressiveHint,
  hintId: string,
): Promise<RevealHintOutcome> {
  const now = new Date().toISOString();
  const record = { hintId: hint.id, revealedAt: now, penaltyApplied: hint.penalty };
  try {
    const updated = await writeHintReveal(shared, item.PK, hint, record, now);
    const totalScore = Number((updated.Attributes as { score?: unknown })?.score ?? -hint.penalty);
    await writeHintScoreEvent(shared, item, hint, hintId, now);
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

function writeHintReveal(
  shared: ParticipantSharedResources,
  PK: string,
  hint: ProgressiveHint,
  record: { readonly hintId: string; readonly revealedAt: string; readonly penaltyApplied: number },
  now: string,
) {
  return shared.ddb.send(
    new UpdateCommand({
      TableName: shared.tableName,
      Key: { PK, SK: "META" },
      UpdateExpression:
        "SET hintsRevealed = list_append(if_not_exists(hintsRevealed, :empty), :record), updatedAt = :now " +
        "ADD score :neg",
      ConditionExpression:
        "attribute_not_exists(hintsRevealed) OR NOT contains(hintsRevealed, :recordForContains)",
      ExpressionAttributeValues: {
        ":empty": [],
        ":record": [record],
        ":recordForContains": record,
        ":now": now,
        ":neg": hint.penalty === 0 ? 0 : -hint.penalty,
      },
      ReturnValues: "ALL_NEW",
    }),
  );
}

async function writeHintScoreEvent(
  shared: ParticipantSharedResources,
  item: Partial<DeploymentItem> & { problemId: string },
  hint: ProgressiveHint,
  hintId: string,
  now: string,
): Promise<void> {
  if (hint.penalty === 0) return;
  // #1243: 旧実装は Put 失敗を console.warn で握り潰していたが、 score 減点 (UpdateItem) は
  // 確定しているのに score event 履歴が空のままになり、 「-10 pt なのに履歴 0 件」 表示の
  // 不整合を生んでいた (submit-flag #745 と同じ root cause)。 AGENTS.md 「モック / スタブで
  // 握り潰す fallback 禁止」 違反だったので、 失敗は log した上で throw し、
  // route-helpers の internal_error 経路で 500 を返す (= CloudWatch + Portal retry に乗せる)。
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
    console.error("[reveal-hint] writeScoreEvent failed", {
      jobId: item.jobId,
      hintId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
