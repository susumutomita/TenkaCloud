import { resolveDefaultUrl } from "../../../../utils/endpoints-metadata.js";
import type { PhasedPollingScoringMetadata } from "../../../../utils/scoring-metadata.js";
import { parseStackOutputs } from "../../shared/cfn-status.js";
import {
  type DeploymentScoringState,
  joinUrl,
  type KindHandlerInput,
  type KindResult,
  type KindScoreEvent,
  noopKindResult,
  type PhaseEntry,
  probeUrl,
} from "../shared.js";

/**
 * `phased-polling` kind (ADR-012 Phase 3.B、microservice-migration-battle 想定)。
 *
 * 動作:
 *   1. `nowMs - createdAt` から phaseElapsedMin を算出し、metadata.phases[] から active phase
 *      を確定 (= afterMinutes <= elapsed を満たす最後の phase)。
 *   2. 各 slot に対し `/meta` (= platform 自己申告) を probe して platform を分類。
 *   3. 各 slot に対し `/score` (= phase.scorePathOverride があれば そちら) を probe。
 *   4. platformRules[<platform>] から rule を引き、
 *      - 通常時 → `points` を加算
 *      - phase で degraded 化されている platform → `degradedPoints` を加算
 *      - rule が無い / probe 失敗 → `failurePenalty` を加算
 *   5. `responsePenalties` を slot 毎に適用 (= responseTimeMs 条件で減点)。
 *   6. `bonuses` を deployment 全体で評価 (= 例 all-slots-on-platforms、`once: true` は前回
 *      awarded を `bonusAwarded.<bonus.kind>` で記録)。
 *
 * health は per-slot で 1 つの ok flag (= /score probe success) を `endpointsHealth` に
 * 入れる (participant-portal の applicationStatus aggregate と互換)。
 */
export async function runPhasedPollingKind(
  input: KindHandlerInput<PhasedPollingScoringMetadata>,
): Promise<KindResult> {
  const { deployment, scoring, slots, overrides, phases, nowMs, nowIso, prevState } = input;
  if (!deployment.PK || !deployment.problemId) return noopKindResult();
  if (slots.length === 0) return noopKindResult();

  const outputs = parseStackOutputs(deployment.stackOutputs);
  const overrideMap = new Map<string, string>();
  for (const o of overrides) overrideMap.set(o.slot, o.overrideUrl);

  // 1. phase 確定
  const createdAtMs = deployment.createdAt ? Date.parse(deployment.createdAt) : nowMs;
  const elapsedMin = Math.max(0, (nowMs - createdAtMs) / 60_000);
  const activePhase = resolveActivePhase(phases, elapsedMin);

  // probe path 上書き (= phase で /score?legacy=true 等に切替)
  const scorePath = activePhase?.effect?.scorePathOverride ?? scoring.probe.scorePath;
  const degradedPlatforms = new Set<string>(activePhase?.effect?.switchPlatformToDegraded ?? []);

  // 2/3. /meta + /score を slot 毎に並列 probe
  const slotResults = await Promise.all(
    slots.map(async (slot) => {
      const overrideUrl = overrideMap.get(slot.slot);
      const outputValue = outputs[slot.default.key];
      const defaultUrl = outputValue
        ? resolveDefaultUrl(outputValue, slot.default.appendPath)
        : undefined;
      const baseUrl = overrideUrl ?? defaultUrl;
      if (!baseUrl) {
        return {
          slotName: slot.slot,
          baseUrl: undefined,
          platform: undefined,
          scoreOk: false,
          responseTimeMs: 0,
        };
      }
      const [metaProbe, scoreProbe] = await Promise.all([
        probeUrl(joinUrl(baseUrl, scoring.probe.metaPath), { readBody: true }),
        probeUrl(joinUrl(baseUrl, scorePath)),
      ]);
      return {
        slotName: slot.slot,
        baseUrl,
        platform: parsePlatformFromMeta(metaProbe.body),
        scoreOk: scoreProbe.ok,
        responseTimeMs: scoreProbe.responseTimeMs,
      };
    }),
  );

  const allUnresolved = slotResults.every((r) => !r.baseUrl);
  if (allUnresolved) return noopKindResult();

  // 4. platformRules + failurePenalty 適用
  let scoreDelta = 0;
  const scoreEvents: KindScoreEvent[] = [];
  const newHealth: Record<string, { ok: boolean; checkedAt: string }> = {};
  for (const r of slotResults) {
    newHealth[r.slotName] = { ok: r.scoreOk, checkedAt: nowIso };
    if (!r.baseUrl) continue;
    if (!r.scoreOk) {
      const penalty = scoring.failurePenalty ?? 0;
      if (penalty !== 0) {
        scoreDelta += penalty;
        scoreEvents.push({ source: "uptime", points: penalty, occurredAt: nowIso });
      }
      continue;
    }
    const platformName = r.platform;
    const rule = platformName ? scoring.platformRules[platformName] : undefined;
    if (!platformName || !rule) {
      // platform 不明 / 未登録 → failurePenalty 扱い (= 未登録 platform を運営が認めない)
      const penalty = scoring.failurePenalty ?? 0;
      if (penalty !== 0) {
        scoreDelta += penalty;
        scoreEvents.push({ source: "uptime", points: penalty, occurredAt: nowIso });
      }
      continue;
    }
    const isDegraded = degradedPlatforms.has(platformName);
    const points =
      isDegraded && rule.degradedPoints !== undefined ? rule.degradedPoints : rule.points;
    if (points !== 0) {
      scoreDelta += points;
      scoreEvents.push({ source: "uptime", points, occurredAt: nowIso });
    }
    // 5. responsePenalties: 通過した slot のみ評価
    for (const pen of scoring.responsePenalties ?? []) {
      if (evalResponseCondition(pen.if, r.responseTimeMs) && pen.points !== 0) {
        scoreDelta += pen.points;
        scoreEvents.push({ source: "uptime", points: pen.points, occurredAt: nowIso });
      }
    }
  }

  // 6. bonuses: 全 slot 集合に対する判定 (1 回 / once 制御)
  const prevAwarded = prevState.bonusAwarded ?? {};
  const newAwarded: Record<string, boolean> = { ...prevAwarded };
  for (const bonus of scoring.bonuses ?? []) {
    if (bonus.once && prevAwarded[bonus.kind] === true) continue;
    const satisfied = isBonusSatisfied(bonus, slotResults);
    if (!satisfied) continue;
    scoreDelta += bonus.points;
    scoreEvents.push({ source: "uptime", points: bonus.points, occurredAt: nowIso });
    if (bonus.once) newAwarded[bonus.kind] = true;
  }

  const allOk = slotResults.every((r) => r.scoreOk);
  const newState: DeploymentScoringState | undefined =
    Object.keys(newAwarded).length > 0 ? { bonusAwarded: newAwarded } : undefined;

  return {
    scoreDelta,
    scoreEvents,
    endpointsHealthJson: JSON.stringify(newHealth),
    lastResult: allOk ? "ok" : "fail",
    ...(newState ? { newState } : {}),
  };
}

/**
 * `phaseElapsedMin` から active phase を確定。phases[] は afterMinutes 昇順 (= metadata
 * 規約) を前提に、 elapsed 以下の最後の entry を返す。順序保証されない場合に備えて defensive
 * に sort する。
 */
function resolveActivePhase(
  phases: readonly PhaseEntry[],
  elapsedMin: number,
): PhaseEntry | undefined {
  const sorted = [...phases].sort((a, b) => a.afterMinutes - b.afterMinutes);
  let active: PhaseEntry | undefined;
  for (const p of sorted) {
    if (elapsedMin >= p.afterMinutes) active = p;
  }
  return active;
}

/**
 * `/meta` 応答 body から platform 識別子を抽出。 JSON で `{ "platform": "ec2" }` を期待する。
 * 任意形式 (= text/plain "ec2") も低リスク fallback として許容する。
 */
function parsePlatformFromMeta(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { platform?: unknown };
    if (typeof parsed.platform === "string") return parsed.platform;
  } catch {
    // fallthrough: text/plain として trim
  }
  const trimmed = body.trim();
  if (trimmed.length > 0 && trimmed.length < 64) return trimmed;
  return undefined;
}

/**
 * `responseTimeMs > N` のみサポート (Phase 3.B 範囲)。 拡張は別 ADR で。
 */
function evalResponseCondition(expr: string, responseTimeMs: number): boolean {
  const m = expr.match(/^responseTimeMs\s*>\s*(\d+)$/);
  if (!m) return false;
  const threshold = Number(m[1]);
  return responseTimeMs > threshold;
}

/**
 * 既知の bonus kind:
 *   - `all-slots-on-platforms`: bonus.platforms 配列のいずれかの platform に全 slot が乗っている
 *
 * 不明な kind は false。
 */
function isBonusSatisfied(
  bonus: { readonly kind: string; readonly platforms?: readonly string[] },
  slotResults: readonly { readonly platform: string | undefined }[],
): boolean {
  if (bonus.kind === "all-slots-on-platforms") {
    if (!bonus.platforms || bonus.platforms.length === 0) return false;
    const allowed = new Set(bonus.platforms);
    return slotResults.every((r) => r.platform !== undefined && allowed.has(r.platform));
  }
  return false;
}
