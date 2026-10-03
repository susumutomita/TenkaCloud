import type {
  DisruptionTrigger,
  ProblemDisruptionEntry,
} from "../../../utils/discover-problems-catalog.js";
import { type PhaseEntry, resolveActivePhase } from "./shared.js";

/**
 * [Issue #1422] condition-triggered disruption の純粋な評価ロジック。
 *
 * scoring Lambda の 1 tick で、 1 deployment (= 1 team の 1 problem) について観測値
 * (= 採点後 score / deploy 経過分 / active phase) を見て、 どの disruption を「今」発火させるかを返す。
 *
 * - 複数 trigger は OR 結合 (最初に true になった条件で発火)
 * - 一度発火した disruption は `alreadyFired` で抑制し、再発火させない
 * - `triggers` 未宣言の disruption は Phase 1 self-fire のみ (= ここでは無視)
 *
 * I/O を持たない純関数なので、 caller (index.ts) が publish と state 永続化を担う。
 */

export interface DisruptionTriggerContext {
  /** この tick の採点を反映した後の team 累計 score。 */
  readonly scoreAfter: number;
  /** deploy からの経過分 (= `(nowMs - createdAtMs) / 60000`)。 */
  readonly elapsedMin: number;
  /** problem の phases[] (= phase-entered trigger の解決に使う)。 */
  readonly phases: readonly PhaseEntry[];
}

export interface FiredDisruption {
  readonly disruptionId: string;
  readonly eventDetailType: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly triggerKind: DisruptionTrigger["kind"];
  /**
   * 宣言されていれば、 この条件発火を executor が `rate` schedule で定期化する
   * (= 「スコア一定以上で定期妨害」)。 省略 = 1 回だけ。 publish 時に Detail へ載せる。
   */
  readonly recurrence?: { readonly intervalMinutes: number; readonly maxFires: number };
}

/** 1 trigger が現在の観測値で成立しているか。 */
export function triggerMatches(
  trigger: DisruptionTrigger,
  ctx: DisruptionTriggerContext,
  currentPhaseName: string | undefined,
): boolean {
  switch (trigger.kind) {
    case "after-deploy":
      return ctx.elapsedMin >= trigger.afterMinutes;
    case "team-score-above":
      return ctx.scoreAfter > trigger.threshold;
    case "phase-entered":
      return currentPhaseName === trigger.phaseName;
  }
}

/**
 * 「今 tick で新たに発火すべき disruption」 を返す。 既に発火済み (= `alreadyFired`) や
 * trigger 未宣言の disruption は除外する。
 */
export function evaluateDisruptionTriggers(
  disruptions: readonly ProblemDisruptionEntry[],
  ctx: DisruptionTriggerContext,
  alreadyFired: ReadonlySet<string>,
): FiredDisruption[] {
  const currentPhaseName = resolveActivePhase(ctx.phases, ctx.elapsedMin)?.name;
  const fired: FiredDisruption[] = [];
  for (const d of disruptions) {
    if (!d.triggers || d.triggers.length === 0) continue;
    if (alreadyFired.has(d.id)) continue;
    const match = d.triggers.find((t) => triggerMatches(t, ctx, currentPhaseName));
    if (!match) continue;
    fired.push({
      disruptionId: d.id,
      eventDetailType: d.eventDetailType,
      parameters: d.parameters ?? {},
      triggerKind: match.kind,
      ...(d.recurrence ? { recurrence: d.recurrence } : {}),
    });
  }
  return fired;
}
