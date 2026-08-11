import type { DeploymentsScoringPort } from "../../control-data/deployments-repository.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { putEventsBatched } from "../shared/events.js";
import { buildActiveDisruptionEffect } from "./disruption-effects.js";
import { evaluateDisruptionTriggers, type FiredDisruption } from "./disruption-triggers.js";
import {
  type DeploymentScoringState,
  type GenericScoringSharedResources,
  type KindResult,
  type PhaseEntry,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * #1422: scoring tick の condition-triggered disruption 発火 I/O。
 *
 * 純粋な trigger 評価は {@link evaluateDisruptionTriggers} (disruption-triggers.ts) に閉じ、
 * 本 module は「評価 → publish → idempotency 永続化」 の副作用 (EventBridge / DDB) だけを担う。
 * dispatcher (index.ts) を routing/orchestration 層に保ち、 SDK 依存をこの service 層に寄せる
 * (= Issue #986 SOLID 監査の routes / service / repository 分離方針)。
 */

const DISRUPTION_EVENT_SOURCE = "tenkacloud.disruptions";

/**
 * 1 deployment について condition-triggered disruption を評価 → publish → idempotency 記録。
 * bus 未配線 / 当該 problem に disruption 無し / 新規発火 0 件なら no-op。 publish 失敗時は throw して
 * firedDisruptions を永続化しない (= 次 tick で再評価、 at-least-once)。
 */
export async function maybeFireConditionDisruptions(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  result: KindResult,
  prevState: DeploymentScoringState,
  phasesByProblemId: Record<string, readonly PhaseEntry[]>,
  nowMs: number,
  nowIso: string,
): Promise<void> {
  // [Issue #2441 / Phase B2] `setScoringState` derives its physical key from
  // `jobId` (it no longer accepts a raw PK), so the guard also requires it —
  // every real Scan row carries `jobId` (written at deploy time, never
  // removed), so this tightens rather than changes production behavior.
  //
  // [Issue #2441 / Phase B3] `item` flows from
  // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
  // `DeploymentRecord` never carries the physical `PK` — the `!item.PK` half of
  // this guard would now always be true, silently short-circuiting every tick.
  // Dropped; `jobId` alone is the correct precondition.
  if (!shared.eventBusName || !item.problemId || !item.jobId) return;
  const disruptions = shared.problemsDisruptions[item.problemId];
  if (!disruptions || disruptions.length === 0) return;

  const createdAtMs = item.createdAt ? Date.parse(item.createdAt) : nowMs;
  const elapsedMin = Math.max(0, (nowMs - createdAtMs) / 60_000);
  const scoreAfter = (item.score ?? 0) + result.scoreDelta;
  const alreadyFired = new Set(prevState.firedDisruptions ?? []);

  const fired = evaluateDisruptionTriggers(
    disruptions,
    { scoreAfter, elapsedMin, phases: phasesByProblemId[item.problemId] ?? [] },
    alreadyFired,
  );
  if (fired.length === 0) return;

  // publish 成功後にだけ idempotency record を追記する (= 失敗時は throw して次 tick で再評価)。
  await publishConditionDisruptions(shared, item, fired, nowIso);

  // score state は applyKindResult が既に result.newState を書いているので、 それ (無ければ prevState)
  // を base に firedDisruptions だけ merge する (= bonusAwarded / attackCount を温存)。
  const { activeEffects: priorEffects, ...baseState } = result.newState ?? prevState;
  const mergedFired = [...alreadyFired, ...fired.map((f) => f.disruptionId)];
  // [#1665] fire した disruption が effect を宣言していれば減点 window を記録する。
  // 期限切れの prior 効果は prune し、 新規発火分を足す (= 次 tick 以降 applyDisruptionEffects が適用)。
  const survivingPrior = (priorEffects ?? []).filter((e) => e.expiresAtMs > nowMs);
  const newEffects = fired.flatMap((f) => {
    const declared = disruptions.find((d) => d.id === f.disruptionId)?.effect;
    return declared ? [buildActiveDisruptionEffect(f.disruptionId, declared, nowMs)] : [];
  });
  const activeEffects = [...survivingPrior, ...newEffects];
  const stateJson = JSON.stringify({
    ...baseState,
    firedDisruptions: mergedFired,
    ...(activeEffects.length > 0 ? { activeEffects } : {}),
  });
  // [Issue #2441 / Phase B2] Unconditional write (no ConditionExpression) — the
  // seam call is byte-identical to the pre-seam UpdateCommand.
  const repository: DeploymentsScoringPort = await resolveDeploymentsRepository(shared);
  await repository.setScoringState(item.jobId, stateJson, nowIso);
}

/**
 * 発火対象 disruption を event bus に publish する。 detail shape は手動 fire
 * (disruption-fire.ts publishEntries) と一致させ、 downstream の disruption Lambda が同列に扱える
 * ようにする。 requestId は `${jobId}#${disruptionId}` で安定 (= cross-account dedup key 兼用)。
 */
async function publishConditionDisruptions(
  shared: GenericScoringSharedResources,
  item: Partial<DeploymentItem>,
  fired: readonly FiredDisruption[],
  firedAt: string,
): Promise<void> {
  const items = fired.map((f) => ({
    item: f.disruptionId,
    entry: {
      Source: DISRUPTION_EVENT_SOURCE,
      DetailType: f.eventDetailType,
      EventBusName: shared.eventBusName,
      Detail: JSON.stringify({
        disruptionId: f.disruptionId,
        eventId: item.eventId,
        problemId: item.problemId,
        tenantId: item.tenantId,
        teamId: item.teamId,
        parameters: f.parameters,
        requestId: `${item.jobId}#${f.disruptionId}`,
        firedAt,
        triggeredBy: f.triggerKind,
        // 宣言されていれば executor が rate schedule で定期化する (score-gated 定期妨害)。
        ...(f.recurrence ? { recurrence: f.recurrence } : {}),
      }),
    },
  }));
  // Issue #2210: 旧コードは entries.length が 10 を超えると 1 回の PutEventsCommand に収まらず
  // EventBridge の "at most 10 entries" 制約に違反していた (chunk 分割が無かった latent bug)。
  // shared helper に委譲することで chunk 分割 + FailedEntryCount 検査が一箇所になる。
  const results = await putEventsBatched(shared.events, items);
  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    const codes = failed.map((r) => r.errorCode ?? "unknown").join(",");
    throw new Error(`condition disruption publish partial failure: ${codes}`);
  }
}
