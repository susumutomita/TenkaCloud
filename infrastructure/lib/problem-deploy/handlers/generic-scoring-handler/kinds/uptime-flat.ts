import {
  type ProblemEndpointSlot,
  resolveDefaultUrl,
} from "../../../../utils/endpoints-metadata.js";
import type {
  UptimeFlatEndpoint,
  UptimeFlatScoringMetadata,
} from "../../../../utils/scoring-metadata.js";
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
  uptimeEvent,
} from "../scoring-kernel.js";

/**
 * `uptime-flat` kind (legacy `uptime` alias)。
 *
 * 各 endpoint を **独立** に probe する。全 endpoint が ok の時のみ pointsPerSuccess を 1
 * 単位として加点する (= 既存 health-check-handler の挙動を完全保存)。
 *
 * 「全 endpoint ok」 で加点する semantic は legacy uptime と同じ:
 *   - 1 つでも fail があると pointsPerSuccess を 1 単位として **加算しない** (= 既存挙動)
 *   - `lastResult: ok → fail` 遷移時のみ `attack-detected` event を別途 emit
 *
 * endpoint の解決経路は 2 通り (= Phase 3.B で endpoint registry と統合):
 *   - `slot` 指定がある場合 → metadata.endpoints[] の同 slot の default URL (+ override) を probe
 *   - `outputKey` 指定 (legacy) → stackOutputs から直接 URL を引いて probe
 *
 * health は 既存 `endpointsHealth` JSON (= `{[key]: { ok, checkedAt, since? }}`) に書き戻す。
 * key には slot 名 or outputKey を採用し、 participant-portal の applicationStatus aggregate と
 * 整合する。
 */
export async function runUptimeFlatKind(
  input: KindHandlerInput<UptimeFlatScoringMetadata>,
): Promise<KindResult> {
  const { deployment, scoring, slots, overrides, nowIso } = input;
  // [Issue #2441 / Phase B3] `deployment` flows from
  // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
  // `DeploymentRecord` never carries the physical `PK` (unused here beyond this
  // guard) — dropped; `problemId` alone is the correct precondition.
  if (!deployment.problemId) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  const overrideMap = new Map<string, string>();
  for (const o of overrides) overrideMap.set(o.slot, o.overrideUrl);
  const slotMap = new Map(slots.map((s) => [s.slot, s] as const));

  // 各 endpoint を並列 probe。順序は保証しないが結果は key 付きで戻す。
  const probes = await Promise.all(
    scoring.endpoints.map(async (e) => {
      const resolved = resolveEndpointUrl(e, slotMap, overrideMap, outputs);
      if (!resolved) return undefined;
      const probe = await (input.probe ?? probeUrl)(joinUrl(resolved.baseUrl, e.path), {
        expectStatus: e.expectStatus,
      });
      return { key: resolved.healthKey, ok: probe.ok };
    }),
  );

  // 解決できなかった endpoint (= deploy 未完了 / output 不在) は skip。1 つも解決
  // できなければ noop (= 既存 health-check-handler 同型)。
  const resolved = probes.filter((p): p is { key: string; ok: boolean } => p !== undefined);
  if (resolved.length === 0) return noopKindResult();

  const prevHealth = parseEndpointsHealth(deployment.endpointsHealth);
  const newHealth: Record<string, EndpointHealth> = {};
  let allOk = true;
  for (const { key, ok } of resolved) {
    if (!ok) allOk = false;
    const since = computeSince(ok, prevHealth[key], nowIso);
    newHealth[key] = { ok, checkedAt: nowIso, ...(since ? { since } : {}) };
  }

  // 直前 tick が ok → 今 tick fail で attack-detected marker (row 爆発防止)。
  const attackDetected = !allOk && deployment.lastResult === "ok";

  // 失敗時の減点 (opt-in)。 failurePenalty は負値で減点 (uptime-multi と同契約)、 省略時 0 (= 従来挙動)。
  const failureDelta = scoring.failurePenalty ?? 0;

  return {
    scoreDelta: allOk ? scoring.pointsPerSuccess : failureDelta,
    scoreEvents: buildScoreEvents(
      allOk,
      attackDetected,
      scoring.pointsPerSuccess,
      failureDelta,
      nowIso,
    ),
    endpointsHealthJson: JSON.stringify(newHealth),
    lastResult: allOk ? "ok" : "fail",
    ...(attackDetected ? { attackDetected: true } : {}),
  };
}

function buildScoreEvents(
  allOk: boolean,
  attackDetected: boolean,
  points: number,
  failureDelta: number,
  occurredAt: string,
): KindResult["scoreEvents"] {
  if (allOk) return [uptimeEvent(points, occurredAt)];
  // 減点が設定されていれば、 失敗 tick に -N の score event を残す (= 履歴に可視化、 監査痕跡)。
  // 減点 0 のときは従来通り、 ok→fail 遷移の attack-detected marker のみ。
  if (failureDelta !== 0) {
    return [uptimeEvent(failureDelta, occurredAt)];
  }
  return attackDetected ? [{ source: "attack-detected", points: 0, occurredAt }] : [];
}

interface ResolvedEndpoint {
  /** probe する base URL (= effective: override ?? default)。 */
  readonly baseUrl: string;
  /** endpointsHealth JSON の key (= slot 名 or outputKey)。 */
  readonly healthKey: string;
}

function resolveEndpointUrl(
  endpoint: UptimeFlatEndpoint,
  slotMap: Map<string, ProblemEndpointSlot>,
  overrideMap: Map<string, string>,
  outputs: Record<string, string>,
): ResolvedEndpoint | undefined {
  if (endpoint.slot) {
    // 新規経路: slot → effective URL (override ?? default from CFn output)
    const slot = slotMap.get(endpoint.slot);
    const overrideUrl = overrideMap.get(endpoint.slot);
    if (overrideUrl) return { baseUrl: overrideUrl, healthKey: endpoint.slot };
    if (!slot) return undefined;
    const outputValue = outputs[slot.default.key];
    if (!outputValue) return undefined;
    const defaultUrl = resolveDefaultUrl(outputValue, slot.default.appendPath);
    if (!defaultUrl) return undefined;
    return { baseUrl: defaultUrl, healthKey: endpoint.slot };
  }
  if (endpoint.outputKey) {
    // legacy 経路: outputKey 直引き (= 既存 uptime metadata 互換)
    const outputValue = outputs[endpoint.outputKey];
    if (!outputValue) return undefined;
    return { baseUrl: outputValue, healthKey: endpoint.outputKey };
  }
  return undefined;
}
