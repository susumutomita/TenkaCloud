import type {
  DisruptionEffect,
  ProblemDisruptionEntry,
} from "../../../utils/discover-problems-catalog.js";
import type { ActiveDisruptionEffect, KindResult } from "./shared.js";

/**
 * [Issue #1665] disruption の **採点上の効果** を採点 tick に畳み込む純関数。
 *
 * kind handler が出した {@link KindResult} と、 deployment の scoringState に記録された active な効果群を
 * 受け取り、 期限切れ (`expiresAtMs <= nowMs`) を除いた効果を適用した新しい結果と、 生き残った効果リストを返す。
 * 現状 `penalty` のみ: active な各効果の `points` を当該 tick の `scoreDelta` から引く (= window 内の各 tick で
 * 累積減点。「5 cycle ぶん減点」のセマンティクス)。実 cloud への fault 注入は伴わず、
 * `action` とは別レイヤ。副作用なし・全分岐 unit-test 可能。
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
 * fire した disruption の {@link DisruptionEffect} 宣言から active 効果レコードを作る。
 * `expiresAtMs = nowMs + durationSeconds * 1000` で window を確定する (永続しない)。
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

/**
 * 同一 disruptionId の重複効果を 1 件に畳む (condition-triggered と operator-fired が同じ
 * disruption を両方 active にしても二重減点しない)。 expiresAtMs が最大のものを残す。
 */
export function dedupeEffectsByDisruptionId(
  effects: readonly ActiveDisruptionEffect[],
): readonly ActiveDisruptionEffect[] {
  const byId = new Map<string, ActiveDisruptionEffect>();
  for (const e of effects) {
    const prev = byId.get(e.disruptionId);
    if (!prev || e.expiresAtMs > prev.expiresAtMs) byId.set(e.disruptionId, e);
  }
  return [...byId.values()];
}

/** operator が fire した 1 件の disruption audit 行から、 採点効果の解決に要る最小フィールドだけを読む。 */
export interface DisruptionAuditRowLike {
  readonly disruptionId?: unknown;
  readonly problemId?: unknown;
  readonly targetTeamIds?: unknown;
  readonly firedAt?: unknown;
}

/** 1 audit 行が今 active な採点効果かを判定し、 効果 + 対象 team + problemId を返す (= 不正/期限切れは undefined)。 */
function activeEffectForAuditRow(
  row: DisruptionAuditRowLike,
  problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>,
  nowMs: number,
):
  | {
      readonly problemId: string;
      readonly teamIds: string[];
      readonly effect: ActiveDisruptionEffect;
    }
  | undefined {
  if (typeof row.disruptionId !== "string" || typeof row.problemId !== "string") return undefined;
  if (typeof row.firedAt !== "string" || !Array.isArray(row.targetTeamIds)) return undefined;
  const declared = problemsDisruptions[row.problemId]?.find(
    (d) => d.id === row.disruptionId,
  )?.effect;
  if (!declared) return undefined;
  const firedAtMs = Date.parse(row.firedAt);
  if (Number.isNaN(firedAtMs)) return undefined;
  const expiresAtMs = firedAtMs + declared.durationSeconds * 1000;
  if (expiresAtMs <= nowMs) return undefined; // window 経過
  const teamIds = row.targetTeamIds.filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  return {
    problemId: row.problemId,
    teamIds,
    effect: { disruptionId: row.disruptionId, points: declared.points, expiresAtMs },
  };
}

/**
 * [#1665] operator-fired disruption の audit 行群から、 まだ window 内の採点効果を team×problem 別に
 * 解決する。 効果 (points / durationSeconds) は catalog 宣言から引き、 audit 行は「いつ・どの team に」を持つ。
 * 純関数 — caller (handler) が disruptions table を query して行を渡す。 戻り値の key は `${teamId}#${problemId}`。
 */
export function resolveOperatorEffects(
  auditRows: readonly DisruptionAuditRowLike[],
  problemsDisruptions: Readonly<Record<string, readonly ProblemDisruptionEntry[]>>,
  nowMs: number,
): Map<string, ActiveDisruptionEffect[]> {
  const byTeamProblem = new Map<string, ActiveDisruptionEffect[]>();
  for (const row of auditRows) {
    const resolved = activeEffectForAuditRow(row, problemsDisruptions, nowMs);
    if (!resolved) continue;
    for (const teamId of resolved.teamIds) {
      const key = `${teamId}#${resolved.problemId}`;
      const list = byTeamProblem.get(key) ?? [];
      list.push(resolved.effect);
      byTeamProblem.set(key, list);
    }
  }
  return byTeamProblem;
}
