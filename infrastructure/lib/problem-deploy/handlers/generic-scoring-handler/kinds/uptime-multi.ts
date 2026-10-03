import type { AttackProbeResult } from "@tenkacloud/portal-contracts";
import { resolveDefaultUrl } from "../../../../utils/endpoints-metadata.js";
import type { UptimeMultiScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { serializeAttackProbeStatus } from "../../shared/attack-probe-status.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../shared/endpoints-health.js";
import {
  type AttackProbeFn,
  joinUrl,
  type KindHandlerInput,
  type KindResult,
  noopKindResult,
  type ProbeFn,
  probeUrl,
} from "../scoring-kernel.js";
import { scoreCounterDelta } from "./attack-counter.js";

type SlotResolver = (slotName: string) => string | undefined;
type ProbeResult = { key: string; ok: boolean; resolved: boolean };
type ScoreEvent = NonNullable<KindResult["scoreEvents"]>[number];
type AttackProbe = NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number];

/** AND-probe every declared slot; an unresolvable slot is a resolved:false fail (not a noop). */
async function probeAllSlots(
  probedSlots: UptimeMultiScoringMetadata["probedSlots"],
  resolve: SlotResolver,
  probe: ProbeFn,
): Promise<ProbeResult[]> {
  return Promise.all(
    probedSlots.map(async (ps) => {
      const baseUrl = resolve(ps.slot);
      if (!baseUrl) return { key: ps.slot, ok: false, resolved: false };
      const outcome = await probe(joinUrl(baseUrl, ps.path), { expectStatus: ps.expectStatus });
      return { key: ps.slot, ok: outcome.ok, resolved: true };
    }),
  );
}

/** Build the per-slot health map (ok + checkedAt + first-seen-ok `since`). */
function buildNewHealth(
  probes: readonly ProbeResult[],
  prevHealth: Record<string, EndpointHealth>,
  nowIso: string,
): Record<string, EndpointHealth> {
  const newHealth: Record<string, EndpointHealth> = {};
  for (const { key, ok } of probes) {
    const since = computeSince(ok, prevHealth[key], nowIso);
    newHealth[key] = { ok, checkedAt: nowIso, ...(since ? { since } : {}) };
  }
  return newHealth;
}

/**
 * [#1666] optional attack-blocked bonus: live-probe the app's counter endpoint, read the
 * block count from the body, and award the delta since last cycle. Probe failure / bad body = 0.
 */
async function computeAttackBlockedBonus(
  attackBlocked: UptimeMultiScoringMetadata["attackBlocked"],
  resolve: SlotResolver,
  prevAttackCount: number | undefined,
  probeFn: ProbeFn,
): Promise<{ bonusPoints: number; bonusState?: { attackCount: number } }> {
  if (!attackBlocked) return { bonusPoints: 0 };
  const base = resolve(attackBlocked.slot);
  if (!base) return { bonusPoints: 0 };
  const probe = await probeFn(joinUrl(base, attackBlocked.path), { readBody: true });
  if (!probe.ok) return { bonusPoints: 0 };
  const scored = scoreCounterDelta(probe.body, prevAttackCount, attackBlocked.pointsPerBlock);
  if (!scored) return { bonusPoints: 0 };
  return { bonusPoints: scored.points, bonusState: { attackCount: scored.newCount } };
}

/**
 * [#1666, Issue #2422] optional attack-probes: send each attack payload and classify the
 * per-probe outcome for this cycle. A probe whose response status lands in `vulnerableStatus` is
 * `landed` (= defense breached → `penalty` applied); a resolvable probe that returns any other
 * status is `blocked` (= defense held, no penalty); an unresolved / unreachable probe is `skipped`
 * (availability is judged by probedSlots, separately, so we don't penalize or claim a block).
 *
 * `totalPenalty` sums only `landed` probes (= identical scoring to the pre-#2422 penalty). The
 * `outcomes` feed the participant portal so a green-but-unpatched defender sees which probe still
 * lands. Non-spoiler: only the author-provided `label` / `symptom` cross the boundary — never the
 * probe's slot / path.
 */
function attackProbeDisplay(probe: AttackProbe) {
  return {
    penalty: probe.penalty,
    ...(probe.label ? { label: probe.label } : {}),
    ...(probe.symptom ? { symptom: probe.symptom } : {}),
  } as const;
}

async function computeAttackProbeOutcome(
  attackProbe: AttackProbe,
  resolve: SlotResolver,
  probeFn: ProbeFn,
  attackProbeFn: AttackProbeFn | undefined,
): Promise<AttackProbeResult> {
  const display = attackProbeDisplay(attackProbe);
  const base = resolve(attackProbe.slot);
  if (!base) return { ...display, outcome: "skipped" };
  const request = {
    slot: attackProbe.slot,
    path: attackProbe.path,
    ...(attackProbe.method ? { method: attackProbe.method } : {}),
    ...(attackProbe.body !== undefined ? { body: attackProbe.body } : {}),
  };
  const probe = attackProbeFn
    ? await attackProbeFn(request)
    : await probeFn(joinUrl(base, attackProbe.path), {
        ...(attackProbe.method ? { method: attackProbe.method } : {}),
        ...(attackProbe.body !== undefined ? { body: attackProbe.body } : {}),
      });
  if (probe.status === undefined) return { ...display, outcome: "skipped" };
  return {
    ...display,
    outcome: attackProbe.vulnerableStatus.includes(probe.status) ? "landed" : "blocked",
  };
}

async function computeAttackProbeOutcomes(
  attackProbes: UptimeMultiScoringMetadata["attackProbes"],
  resolve: SlotResolver,
  probeFn: ProbeFn,
  attackProbeFn: AttackProbeFn | undefined,
): Promise<{ readonly totalPenalty: number; readonly outcomes: readonly AttackProbeResult[] }> {
  if (!attackProbes || attackProbes.length === 0) return { totalPenalty: 0, outcomes: [] };
  const outcomes = await Promise.all(
    attackProbes.map((probe) => computeAttackProbeOutcome(probe, resolve, probeFn, attackProbeFn)),
  );
  const totalPenalty = outcomes.reduce(
    (sum, o) => (o.outcome === "landed" ? sum + o.penalty : sum),
    0,
  );
  return { totalPenalty, outcomes };
}

/** Build the score-event ledger entries for this cycle. */
function buildScoreEvents(
  baseDelta: number,
  attackDetected: boolean,
  bonusPoints: number,
  attackPenalty: number,
  nowIso: string,
): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  if (baseDelta !== 0) {
    events.push({ source: "uptime", points: baseDelta, occurredAt: nowIso });
  } else if (attackDetected) {
    events.push({ source: "attack-detected", points: 0, occurredAt: nowIso });
  }
  if (bonusPoints > 0) events.push({ source: "uptime", points: bonusPoints, occurredAt: nowIso });
  if (attackPenalty > 0) {
    events.push({ source: "attack-detected", points: -attackPenalty, occurredAt: nowIso });
  }
  return events;
}

/**
 * `uptime-multi` kind (security-battle-royale 想定)。
 *
 * N slot を **AND probe** する。 全 slot が ok の時のみ pointsAllOk を加点、 1 つでも fail
 * があれば failurePenalty (= 通常 0 or 負値) を加点する。
 *
 * `uptime-flat` との違い:
 *   - uptime-flat: 全 ok の時に **pointsPerSuccess を 1 単位として** 加算
 *   - uptime-multi: 全 ok の時に **pointsAllOk** を加算 / fail で failurePenalty を加算 (= 負値で減点)
 *
 * 失敗時に減点する分、 ok 状態をより強く incentivize する設計 (= 全 endpoint 防衛が重要)。
 */
export async function runUptimeMultiKind(
  input: KindHandlerInput<UptimeMultiScoringMetadata>,
): Promise<KindResult> {
  const { deployment, scoring, slots, overrides, nowIso, prevState } = input;
  const probe = input.probe ?? probeUrl;
  // [Issue #2441 / Phase B3] `deployment` flows from
  // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
  // `DeploymentRecord` never carries the physical `PK` (unused here beyond this
  // guard) — dropped; `problemId` alone is the correct precondition.
  if (!deployment.problemId) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  const overrideMap = new Map<string, string>();
  for (const o of overrides) overrideMap.set(o.slot, o.overrideUrl);
  const slotMap = new Map(slots.map((s) => [s.slot, s] as const));

  // slot の effective base URL (= override ?? CFn output 由来 default) を解決する。 probedSlots と
  // attack-blocked probe で共有。
  const resolveSlotBaseUrl = (slotName: string): string | undefined => {
    const overrideUrl = overrideMap.get(slotName);
    if (overrideUrl) return overrideUrl;
    const slot = slotMap.get(slotName);
    if (!slot) return undefined;
    const outputValue = outputs[slot.default.key];
    return outputValue ? resolveDefaultUrl(outputValue, slot.default.appendPath) : undefined;
  };

  const probes = await probeAllSlots(scoring.probedSlots, resolveSlotBaseUrl, probe);

  // 1 つも解決できない場合 (= deploy 未完了) は採点を保留 (= noop)。
  // 一部のみ解決できないケースは fail 扱い (= 防御側が未配備 = ペナルティ正当)。
  const allUnresolved = probes.every((p) => !p.resolved);
  if (allUnresolved) return noopKindResult();

  const allOk = probes.every((p) => p.ok);
  const prevHealth = parseEndpointsHealth(deployment.endpointsHealth);
  const newHealth = buildNewHealth(probes, prevHealth, nowIso);

  const baseDelta = allOk ? scoring.pointsAllOk : (scoring.failurePenalty ?? 0);
  const attackDetected = !allOk && deployment.lastResult === "ok";

  const { bonusPoints, bonusState } = await computeAttackBlockedBonus(
    scoring.attackBlocked,
    resolveSlotBaseUrl,
    prevState.attackCount,
    probe,
  );

  const { totalPenalty: attackPenalty, outcomes: attackOutcomes } =
    await computeAttackProbeOutcomes(
      scoring.attackProbes,
      resolveSlotBaseUrl,
      probe,
      input.attackProbe,
    );

  const scoreDelta = baseDelta + bonusPoints - attackPenalty;
  const scoreEvents = buildScoreEvents(
    baseDelta,
    attackDetected,
    bonusPoints,
    attackPenalty,
    nowIso,
  );
  // [#2422] attackProbes を持つ問題だけ、 直近サイクルの per-probe snapshot を書く
  // (= 他 kind / 旧行は列を持たず後方互換)。 defender が「どの probe がまだ刺さっているか」を見る。
  const attackProbesJson =
    attackOutcomes.length > 0
      ? serializeAttackProbeStatus({ checkedAt: nowIso, probes: attackOutcomes })
      : undefined;
  return {
    scoreDelta,
    scoreEvents,
    endpointsHealthJson: JSON.stringify(newHealth),
    ...(attackProbesJson !== undefined ? { attackProbesJson } : {}),
    lastResult: allOk ? "ok" : "fail",
    ...(attackDetected || attackPenalty > 0 ? { attackDetected: true } : {}),
    ...(bonusState ? { newState: bonusState } : {}),
  };
}
