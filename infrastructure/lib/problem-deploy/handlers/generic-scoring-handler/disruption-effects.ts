import type { DisruptionEffect } from "../../../utils/discover-problems-catalog.js";
import type { ActiveDisruptionEffect, KindResult } from "./shared.js";

/**
 * [ADR-033 / Issue #1665] disruption の **採点上の効果** を採点 tick に畳み込む純関数。
 *
 * kind handler が出した {@link KindResult} と、 deployment の scoringState に記録された active な効果群を
 * 受け取り、 期限切れ (`expiresAtMs <= nowMs`) を除いた効果を適用した新しい結果と、 生き残った効果リストを返す。
 * 現状 `penalty` のみ: active な各効果の `points` を当該 tick の `scoreDelta` から引く (= window 内の各 tick で
 * 累積減点。 ADR-033 の「5 cycle ぶん減点」セマンティクス)。 実 cloud への fault 注入は伴わない (= ADR-031 の
 * `action` とは別レイヤ)。 副作用なし・全分岐 unit-test 可能。
 */
export function applyDisruptionEffects(
  result: KindResult,
  active: readonly ActiveDisruptionEffect[],
  nowMs: number,
): { readonly result: KindResult; readonly surviving: readonly ActiveDisruptionEffect[] } {
  const surviving = active.filter((e) => e.expiresAtMs > nowMs);
  if (surviving.length === 0) {
    // active 効果が無い / すべて期限切れ。 score は据え置き、 surviving は空 (= caller が prune 永続化)。
    return { result, surviving };
  }
  const penalty = surviving.reduce((sum, e) => sum + e.points, 0);
  return {
    result: { ...result, scoreDelta: result.scoreDelta - penalty },
    surviving,
  };
}

/**
 * [ADR-033] fire した disruption の {@link DisruptionEffect} 宣言から active 効果レコードを作る。
 * `expiresAtMs = nowMs + durationSeconds * 1000` で window を確定する (= 永続しない、 ADR-029)。
 */
export function buildActiveDisruptionEffect(
  disruptionId: string,
  effect: DisruptionEffect,
  nowMs: number,
): ActiveDisruptionEffect {
  return {
    disruptionId,
    points: effect.points,
    expiresAtMs: nowMs + effect.durationSeconds * 1000,
  };
}
