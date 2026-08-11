import type { DisruptionTrigger } from "../api/disruptions-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #1775: disruption の自動発火条件を operator 向けの 1 行ラベルにする。
 *
 * 条件は problem metadata.json の `disruptions[].triggers[]` が source of truth
 * (= 採点 tick が評価し OR 結合で発火)。 ここは読み取り表示のみで、 編集は問題
 * オーサリング側 (metadata.json) の責務。
 */
export function describeTrigger(trigger: DisruptionTrigger, t: Translate): string {
  switch (trigger.kind) {
    case "after-deploy":
      return t("disruptions.trigger_after_deploy", { minutes: trigger.afterMinutes });
    case "team-score-above":
      return t("disruptions.trigger_score_above", { threshold: trigger.threshold });
    case "phase-entered":
      return t("disruptions.trigger_phase_entered", { phase: trigger.phaseName });
  }
}

/** triggers 配列を表示用ラベル配列へ。 未宣言 / 空 = 手動発火のみ (空配列を返す)。 */
export function describeTriggers(
  triggers: readonly DisruptionTrigger[] | undefined,
  t: Translate,
): readonly string[] {
  if (!triggers || triggers.length === 0) return [];
  return triggers.map((trigger) => describeTrigger(trigger, t));
}
