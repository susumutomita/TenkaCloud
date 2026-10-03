import type { AttackDetectionScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import { type KindHandlerInput, type KindResult, noopKindResult } from "../scoring-kernel.js";
import { scoreCounterDelta } from "./attack-counter.js";

/**
 * `attack-detection` kind (security-battle-royale の攻撃検知部 想定)。
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
  // [Issue #2441 / Phase B3] `deployment` flows from
  // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
  // `DeploymentRecord` never carries the physical `PK` (unused here beyond this
  // guard) — dropped; `problemId` alone is the correct precondition.
  if (!deployment.problemId) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  // 差分加点 + cap + baseline 追従の共通ロジックは attack-counter.ts に集約し、uptime-multi の
  // attack-blocked bonus と共有する。不正値 / 未露出は noop。
  const scored = scoreCounterDelta(
    outputs[scoring.statsOutputKey],
    prevState.attackCount,
    scoring.pointsPerAttack,
  );
  if (!scored) return noopKindResult();
  return {
    scoreDelta: scored.points,
    scoreEvents:
      scored.points > 0 ? [{ source: "uptime", points: scored.points, occurredAt: nowIso }] : [],
    newState: { attackCount: scored.newCount },
  };
}
