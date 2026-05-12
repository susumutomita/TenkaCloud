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
  const { deployment, scoring, slots, overrides, nowIso } = input;
  if (!deployment.PK || !deployment.problemId) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  const overrideMap = new Map<string, string>();
  for (const o of overrides) overrideMap.set(o.slot, o.overrideUrl);
  const slotMap = new Map(slots.map((s) => [s.slot, s] as const));

  const probes = await Promise.all(
    scoring.probedSlots.map(async (ps) => {
      const overrideUrl = overrideMap.get(ps.slot);
      let baseUrl: string | undefined;
      if (overrideUrl) baseUrl = overrideUrl;
      else {
        const slot = slotMap.get(ps.slot);
        if (slot) {
          const outputValue = outputs[slot.default.key];
          if (outputValue) baseUrl = resolveDefaultUrl(outputValue, slot.default.appendPath);
        }
      }
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

  const scoreDelta = allOk ? scoring.pointsAllOk : (scoring.failurePenalty ?? 0);
  const attackDetected = !allOk && deployment.lastResult === "ok";

  return {
    scoreDelta,
    scoreEvents:
      scoreDelta !== 0
        ? [{ source: "uptime", points: scoreDelta, occurredAt: nowIso }]
        : attackDetected
          ? [{ source: "attack-detected", points: 0, occurredAt: nowIso }]
          : [],
    endpointsHealthJson: JSON.stringify(newHealth),
    lastResult: allOk ? "ok" : "fail",
    ...(attackDetected ? { attackDetected: true } : {}),
  };
}
