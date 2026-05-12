import type { AttackDetectionScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import { type KindHandlerInput, type KindResult, noopKindResult } from "../shared.js";

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

  const current = Number(rawValue);
  if (!Number.isFinite(current) || current < 0) return noopKindResult();

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

  const points = delta * scoring.pointsPerAttack;
  return {
    scoreDelta: points,
    scoreEvents: [{ source: "uptime", points, occurredAt: nowIso }],
    newState: { attackCount: current },
  };
}
