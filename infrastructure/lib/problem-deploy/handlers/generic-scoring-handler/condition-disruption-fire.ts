import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { buildActiveDisruptionEffect } from "./disruption-effects.js";
import { evaluateDisruptionTriggers, type FiredDisruption } from "./disruption-triggers.js";
import type {
  DeploymentScoringState,
  GenericScoringSharedResources,
  KindResult,
  PhaseEntry,
} from "./shared.js";

/**
 * #1422 (ADR-013 Phase 2): scoring tick の condition-triggered disruption 発火 I/O。
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
  if (!shared.eventBusName || !item.problemId || !item.PK) return;
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
  // [ADR-033 / #1665] fire した disruption が effect を宣言していれば減点 window を記録する。
  // 期限切れの prior 効果は prune し、 新規発火分を足す (= 次 tick 以降 applyDisruptionEffects が適用)。
  const survivingPrior = (priorEffects ?? []).filter((e) => e.expiresAtMs > nowMs);
  const newEffects = fired.flatMap((f) => {
    const declared = disruptions.find((d) => d.id === f.disruptionId)?.effect;
    return declared ? [buildActiveDisruptionEffect(f.disruptionId, declared, nowMs)] : [];
  });
  const activeEffects = [...survivingPrior, ...newEffects];
  await shared.ddb.send(
    new UpdateCommand({
      TableName: shared.deploymentsTableName,
      Key: { PK: item.PK, SK: "META" },
      UpdateExpression: "SET scoringState = :state, updatedAt = :now",
      ExpressionAttributeValues: {
        ":state": JSON.stringify({
          ...baseState,
          firedDisruptions: mergedFired,
          ...(activeEffects.length > 0 ? { activeEffects } : {}),
        }),
        ":now": nowIso,
      },
    }),
  );
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
  const entries = fired.map((f) => ({
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
      // [ADR-037 Slice 3] 宣言されていれば executor が rate() schedule で定期化する (= score-gated 定期妨害)。
      ...(f.recurrence ? { recurrence: f.recurrence } : {}),
    }),
  }));
  const resp = await shared.events.send(new PutEventsCommand({ Entries: entries }));
  if ((resp.FailedEntryCount ?? 0) > 0) {
    const codes = (resp.Entries ?? [])
      .filter((e) => e.ErrorCode)
      .map((e) => e.ErrorCode)
      .join(",");
    throw new Error(`condition disruption publish partial failure: ${codes}`);
  }
}
