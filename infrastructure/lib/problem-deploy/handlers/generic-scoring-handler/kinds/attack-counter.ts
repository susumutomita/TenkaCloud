/**
 * [Issue #1666] CFn-output attack counter からの差分加点の共通ロジック。
 *
 * 競技者 stack が「攻撃をブロック/検知した回数」を CFn Output に counter として露出し、 採点 tick が
 * 前回値からの差分に応じて加点する (= 防御の成否を採点に反映する)。 元は attack-detection kind 内にあった
 * ロジックを、 uptime-multi の attack-blocked ボーナス (pattern B のスコア統合) と共有するため切り出した。
 *
 * 競技者は自 account の CFn Output に任意値を仕込めるため、 1 tick の差分加点には上限を設ける
 * (= leaderboard の即時 inflation 防止)。 baseline は実値に追従し、 巨大ジャンプは 1 tick 分で止まる。
 */

/** 1 tick あたりに反映する counter 差分の上限 (#1389)。 */
export const MAX_ATTACK_DELTA_PER_TICK = 100;

export interface CounterScore {
  /** この tick で加点する点数 (= 差分 × pointsPer、 上限 cap 済)。 baseline tick は 0。 */
  readonly points: number;
  /** 次 tick の baseline として記録する現在値。 */
  readonly newCount: number;
}

/**
 * CFn Output から読んだ counter (string) と前回値から差分加点を計算する。 不正値 (空 / 非整数 / 負) は
 * `undefined` (= baseline 汚染を避けるため採点しない)。 prev 未定義 (初回) は baseline 記録のみで 0 点。
 */
export function scoreCounterDelta(
  rawValue: unknown,
  prevCount: number | undefined,
  pointsPer: number,
): CounterScore | undefined {
  if (rawValue === undefined) return undefined;
  const normalized = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if (normalized === "") return undefined;
  const current = Number(normalized);
  if (!Number.isFinite(current) || !Number.isInteger(current) || current < 0) return undefined;
  // 初回 tick: deploy 後の既存値を新検知扱いしない (= baseline 記録のみ)。
  if (prevCount === undefined) return { points: 0, newCount: current };
  const delta = current - prevCount;
  // 巻き戻し / 同値 → 加点なし、 baseline を current に追従。
  if (delta <= 0) return { points: 0, newCount: current };
  const cappedDelta = Math.min(delta, MAX_ATTACK_DELTA_PER_TICK);
  return { points: cappedDelta * pointsPer, newCount: current };
}
