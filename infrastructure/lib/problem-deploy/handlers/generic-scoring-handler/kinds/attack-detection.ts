import type { AttackDetectionScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import { type KindHandlerInput, type KindResult, noopKindResult } from "../shared.js";

/**
 * 1 tick あたりに加点へ反映する attack 差分の上限 (#1389)。 attack counter は競技者が admin 権限
 * を持つ自 account の CFn Output から読むため任意の巨大値を仕込める。 差分加点に上限を設けることで
 * leaderboard の即時 inflation を防ぐ。 baseline は実値に追従させるため、 巨大ジャンプは 1 tick 分の
 * 上限加点で止まり、 次 tick 以降は再加算されない。
 */
const MAX_ATTACK_DELTA_PER_TICK = 100;

/**
 * `attack-detection` kind (ADR-012 Phase 3.B、 security-battle-royale の攻撃検知部 想定)。
 *
 * 問題 stack に同梱した attack counter (= CFn Output に counter 値を露出するか、 SSM Parameter
 * name 等の参照を露出する) を読み、 前回 tick との差分に応じて加点する。
 *
 * 本 Phase では CFn Output に **生 counter (数値)** を露出する規約だけサポートする。SSM
 * Parameter / CloudWatch Logs 経路は将来拡張で扱う。
 *
 * state map: `attackCount` に前回値を記録。次 tick で差分 (= current - prev) を pointsPerAttack
 * 倍して加算する。初回 tick (prev=undefined) は加算 0、 baseline として current を記録するのみ。
 */
export function runAttackDetectionKind(
  input: KindHandlerInput<AttackDetectionScoringMetadata>,
): KindResult {
  const { deployment, scoring, nowIso, prevState } = input;
  if (!deployment.PK || !deployment.problemId) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  const rawValue = outputs[scoring.statsOutputKey];
  if (rawValue === undefined) return noopKindResult();

  // 問題側の CFn Output は string なので Number() で coerce する。 ただし `""` → 0、
  // `"1.5"` → 1.5 のような falsy/fractional case は不正データ扱いで noop (= baseline 汚染防止)。
  const normalized = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if (normalized === "") return noopKindResult();
  const current = Number(normalized);
  if (!Number.isFinite(current) || !Number.isInteger(current) || current < 0) {
    return noopKindResult();
  }

  const prev = prevState.attackCount;
  // 初回 tick: baseline 記録のみで加点しない (= deploy 後の counter 既存値を新検知扱いしない)
  if (prev === undefined) {
    return {
      scoreDelta: 0,
      scoreEvents: [],
      newState: { attackCount: current },
    };
  }

  const delta = current - prev;
  if (delta <= 0) {
    // counter 巻き戻し / 同値 → 加点なし、 baseline を current に追従する
    return {
      scoreDelta: 0,
      scoreEvents: [],
      newState: { attackCount: current },
    };
  }

  // 1 tick あたりの差分加点に上限を設ける (= 競技者が CFn Output に巨大値を仕込んでも leaderboard を
  // 即時 inflation できない)。 baseline は実値 (current) に追従させ、 巨大ジャンプは 1 tick で止める。
  const cappedDelta = Math.min(delta, MAX_ATTACK_DELTA_PER_TICK);
  const points = cappedDelta * scoring.pointsPerAttack;
  return {
    scoreDelta: points,
    scoreEvents: [{ source: "uptime", points, occurredAt: nowIso }],
    newState: { attackCount: current },
  };
}
