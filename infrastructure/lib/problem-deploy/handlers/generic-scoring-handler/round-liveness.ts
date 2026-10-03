import type { DeploymentItem } from "../deploy-handler/types.js";

/**
 * #1421: Attack-resilience liveness invariants。
 *
 * 競技 (Battle round) は攻撃 / disruption が当たっても **必ず終端に達する**ことを platform が保証する。
 * 本 module はその 2 つの invariant を純関数として encode する:
 *
 *  1. **"every round reaches a terminal state"** — round に明示 `endsAt` が無くても、
 *     `startsAt + MAX_ROUND_DURATION_MINUTES` で必ず終端に達する (= 採点 / leaderboard が hang しない)。
 *  2. **"no disruption is permanent"** — disruption の injection window は round 開始〜終端に限定される。
 *     round が必ず終端に達する (#1 ) ため、 注入された fault は最長でも round 長で打ち切られる
 *     (= teardown で revert される)。 終端後の新規 disruption 発火は許さない。
 *
 * `MAX_ROUND_DURATION_MINUTES` は「正常運用の round 長」ではなく **liveness safety-net** である。
 * 30 日は どの Battle round よりも長く、 deployment の `expiresAt` (TTL、 通常 数時間〜数日) よりも
 * 十分長いので、 正常な採点 / evergreen Challenge を打ち切らずに「無限 hang」だけを防ぐ。
 */

/** liveness safety-net (= 30 日)。 endsAt 未設定 round の強制終端 cap。 */
export const MAX_ROUND_DURATION_MINUTES = 30 * 24 * 60;

/** round 窓の最小表現 (= deployment 行に denormalize された event の開始 / 終了)。 */
export type RoundWindow = Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">;

/**
 * round の **必ず有限な**終端時刻 (ISO8601) を返す。
 * - `eventEndsAt` 明示があればそれを採用 (= operator / event schedule が決めた終端)。
 * - 無ければ `eventStartsAt + MAX_ROUND_DURATION_MINUTES` (= liveness cap)。
 * - `eventStartsAt` も無効なら `undefined` (= round 未開始、 採点 gate が別途弾く)。
 *
 * これにより 「endsAt を付け忘れた round が永遠に scoreable」 という hang を構造的に排除する
 * (= invariant "every round reaches a terminal state")。
 */
export function resolveRoundTerminalAt(
  round: RoundWindow,
  capMinutes: number = MAX_ROUND_DURATION_MINUTES,
): string | undefined {
  if (typeof round.eventEndsAt === "string" && round.eventEndsAt.length > 0) {
    return round.eventEndsAt;
  }
  if (typeof round.eventStartsAt !== "string") return undefined;
  const startMs = Date.parse(round.eventStartsAt);
  if (Number.isNaN(startMs)) return undefined;
  return new Date(startMs + capMinutes * 60_000).toISOString();
}

/**
 * round が終端に達したか (= now >= 解決済み終端)。 終端が解決できない (= 未開始) 場合は false。
 * ISO8601 UTC の辞書順比較で安全 (= 既存 scoring gate と同方式)。
 */
export function isRoundTerminated(
  round: RoundWindow,
  nowIso: string,
  capMinutes?: number,
): boolean {
  const terminal = resolveRoundTerminalAt(round, capMinutes);
  if (!terminal) return false;
  return nowIso >= terminal;
}
