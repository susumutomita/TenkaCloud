import { resolveDefaultUrl } from "../../../../utils/endpoints-metadata.js";
import type { UptimeMultiScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import {
  computeSince,
  type EndpointHealth,
  parseEndpointsHealth,
} from "../../shared/endpoints-health.js";
import {
  joinUrl,
  type KindHandlerInput,
  type KindResult,
  noopKindResult,
  probeUrl,
} from "../shared.js";
import { scoreCounterDelta } from "./attack-counter.js";

/**
 * `uptime-multi` kind (ADR-012 Phase 3.B、 security-battle-royale 想定)。
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
  if (!deployment.PK || !deployment.problemId) return noopKindResult();

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

  const probes = await Promise.all(
    scoring.probedSlots.map(async (ps) => {
      const baseUrl = resolveSlotBaseUrl(ps.slot);
      if (!baseUrl) return { key: ps.slot, ok: false, resolved: false };
      const probe = await probeUrl(joinUrl(baseUrl, ps.path), { expectStatus: ps.expectStatus });
      return { key: ps.slot, ok: probe.ok, resolved: true };
    }),
  );

  // 1 つも解決できない場合 (= deploy 未完了) は採点を保留 (= noop)。
  // 一部のみ解決できないケースは fail 扱い (= 防御側が未配備 = ペナルティ正当)。
  const allUnresolved = probes.every((p) => !p.resolved);
  if (allUnresolved) return noopKindResult();

  const allOk = probes.every((p) => p.ok);
  const prevHealth = parseEndpointsHealth(deployment.endpointsHealth);
  const newHealth: Record<string, EndpointHealth> = {};
  for (const { key, ok } of probes) {
    const since = computeSince(ok, prevHealth[key], nowIso);
    newHealth[key] = { ok, checkedAt: nowIso, ...(since ? { since } : {}) };
  }

  const baseDelta = allOk ? scoring.pointsAllOk : (scoring.failurePenalty ?? 0);
  const attackDetected = !allOk && deployment.lastResult === "ok";

  // [ADR-034 / #1666] optional attack-blocked bonus (= 防御テストの加点を可用性採点に重ねる)。 宣言時のみ:
  // アプリの counter endpoint を **live probe** し (静的 CFn output でなく走行中の値)、 応答 body を
  // ブロック回数として読み、 前回からの増分で加点 + baseline を追従。 probe 失敗 / 不正 body は加点 0。
  let bonusPoints = 0;
  let bonusState: { attackCount: number } | undefined;
  if (scoring.attackBlocked) {
    const base = resolveSlotBaseUrl(scoring.attackBlocked.slot);
    if (base) {
      const probe = await probeUrl(joinUrl(base, scoring.attackBlocked.path), { readBody: true });
      const scored = probe.ok
        ? scoreCounterDelta(probe.body, prevState.attackCount, scoring.attackBlocked.pointsPerBlock)
        : undefined;
      if (scored) {
        bonusPoints = scored.points;
        bonusState = { attackCount: scored.newCount };
      }
    }
  }

  // [ADR-034 / #1666] optional attack-probes (= 防御テスト)。 scorer が各 probe へ攻撃 payload を送り、
  // 応答ステータスが vulnerableStatus に含まれれば (= 防御が破れた) penalty を減点する。 防御できていれば 0。
  // 未解決 slot / unreachable は減点しない (= 可用性は probedSlots が見る、 攻撃成否と分離)。
  let attackPenalty = 0;
  if (scoring.attackProbes && scoring.attackProbes.length > 0) {
    const vulnerable = await Promise.all(
      scoring.attackProbes.map(async (ap) => {
        const base = resolveSlotBaseUrl(ap.slot);
        if (!base) return false;
        const probe = await probeUrl(joinUrl(base, ap.path), {
          ...(ap.method ? { method: ap.method } : {}),
          ...(ap.body !== undefined ? { body: ap.body } : {}),
        });
        return probe.status !== undefined && ap.vulnerableStatus.includes(probe.status);
      }),
    );
    attackPenalty = scoring.attackProbes.reduce(
      (sum, ap, i) => (vulnerable[i] ? sum + ap.penalty : sum),
      0,
    );
  }

  const scoreDelta = baseDelta + bonusPoints - attackPenalty;
  const scoreEvents = [
    ...(baseDelta !== 0
      ? [{ source: "uptime" as const, points: baseDelta, occurredAt: nowIso }]
      : attackDetected
        ? [{ source: "attack-detected" as const, points: 0, occurredAt: nowIso }]
        : []),
    ...(bonusPoints > 0
      ? [{ source: "uptime" as const, points: bonusPoints, occurredAt: nowIso }]
      : []),
    ...(attackPenalty > 0
      ? [{ source: "attack-detected" as const, points: -attackPenalty, occurredAt: nowIso }]
      : []),
  ];
  return {
    scoreDelta,
    scoreEvents,
    endpointsHealthJson: JSON.stringify(newHealth),
    lastResult: allOk ? "ok" : "fail",
    ...(attackDetected || attackPenalty > 0 ? { attackDetected: true } : {}),
    ...(bonusState ? { newState: bonusState } : {}),
  };
}
