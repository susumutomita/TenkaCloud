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
  probeUrl,
  resolveActivePhase,
  uptimeEvent,
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
  const slotResults = await probePhasedSlots(input, outputs, overrideMap, scorePath);

  const allUnresolved = slotResults.every((r) => !r.baseUrl);
  if (allUnresolved) return noopKindResult();

  // 4. platformRules + failurePenalty 適用
  const slotScore = scorePhasedSlots(scoring, degradedPlatforms, slotResults, nowIso);

  // 6. bonuses: 全 slot 集合に対する判定 (1 回 / once 制御)
  const bonusScore = scorePhasedBonuses(scoring, slotResults, prevState, nowIso);

  const allOk = slotResults.every((r) => r.scoreOk);
  const newState: DeploymentScoringState | undefined =
    Object.keys(bonusScore.awarded).length > 0 ? { bonusAwarded: bonusScore.awarded } : undefined;

  return {
    scoreDelta: slotScore.scoreDelta + bonusScore.scoreDelta,
    scoreEvents: [...slotScore.scoreEvents, ...bonusScore.scoreEvents],
    endpointsHealthJson: JSON.stringify(slotScore.health),
    lastResult: allOk ? "ok" : "fail",
    ...resolvePostureSnapshot(slotResults),
    ...resolvePlatformSnapshot(slotResults),
    ...(newState ? { newState } : {}),
  };
}

interface SlotResult {
  readonly slotName: string;
  readonly baseUrl: string | undefined;
  readonly platform: string | undefined;
  readonly posture?: Record<string, boolean>;
  readonly posturePlatform?: string;
  readonly scoreOk: boolean;
  readonly responseTimeMs: number;
}

async function probePhasedSlots(
  input: KindHandlerInput<PhasedPollingScoringMetadata>,
  outputs: Record<string, string>,
  overrideMap: Map<string, string>,
  scorePath: string,
): Promise<SlotResult[]> {
  return Promise.all(
    input.slots.map((slot) =>
      probePhasedSlot(slot, input.scoring, outputs, overrideMap.get(slot.slot), scorePath),
    ),
  );
}

async function probePhasedSlot(
  slot: KindHandlerInput<PhasedPollingScoringMetadata>["slots"][number],
  scoring: PhasedPollingScoringMetadata,
  outputs: Record<string, string>,
  overrideUrl: string | undefined,
  scorePath: string,
): Promise<SlotResult> {
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
  const [metaProbe, scoreProbe, postureProbe] = await Promise.all([
    probeUrl(joinUrl(baseUrl, scoring.probe.metaPath), { readBody: true }),
    probeUrl(joinUrl(baseUrl, scorePath)),
    scoring.probe.posturePath
      ? probeUrl(joinUrl(baseUrl, scoring.probe.posturePath), { readBody: true })
      : Promise.resolve(undefined),
  ]);
  const posture = parsePostureFromBody(postureProbe?.body);
  return {
    slotName: slot.slot,
    baseUrl,
    platform: parsePlatformFromMeta(metaProbe.body),
    ...(posture?.posture ? { posture: posture.posture } : {}),
    ...(posture?.platform ? { posturePlatform: posture.platform } : {}),
    scoreOk: scoreProbe.ok,
    responseTimeMs: scoreProbe.responseTimeMs,
  };
}

function scorePhasedSlots(
  scoring: PhasedPollingScoringMetadata,
  degradedPlatforms: Set<string>,
  slotResults: readonly SlotResult[],
  occurredAt: string,
): {
  readonly scoreDelta: number;
  readonly scoreEvents: KindScoreEvent[];
  readonly health: Record<string, { ok: boolean; checkedAt: string }>;
} {
  let scoreDelta = 0;
  const scoreEvents: KindScoreEvent[] = [];
  const health: Record<string, { ok: boolean; checkedAt: string }> = {};
  for (const slot of slotResults) {
    health[slot.slotName] = { ok: slot.scoreOk, checkedAt: occurredAt };
    const score = scorePhasedSlot(scoring, degradedPlatforms, slot, occurredAt);
    scoreDelta += score.scoreDelta;
    scoreEvents.push(...score.scoreEvents);
  }
  return { scoreDelta, scoreEvents, health };
}

function scorePhasedSlot(
  scoring: PhasedPollingScoringMetadata,
  degradedPlatforms: Set<string>,
  slot: SlotResult,
  occurredAt: string,
): { readonly scoreDelta: number; readonly scoreEvents: KindScoreEvent[] } {
  if (!slot.baseUrl) return { scoreDelta: 0, scoreEvents: [] };
  const platformRule = slot.platform ? scoring.platformRules[slot.platform] : undefined;
  if (!slot.scoreOk || !slot.platform || !platformRule) {
    return scoreFailurePenalty(scoring.failurePenalty ?? 0, occurredAt);
  }
  const points =
    degradedPlatforms.has(slot.platform) && platformRule.degradedPoints !== undefined
      ? platformRule.degradedPoints
      : platformRule.points;
  const scoreEvents = points === 0 ? [] : [uptimeEvent(points, occurredAt)];
  for (const penalty of scoring.responsePenalties ?? []) {
    if (evalResponseCondition(penalty.if, slot.responseTimeMs) && penalty.points !== 0) {
      scoreEvents.push(uptimeEvent(penalty.points, occurredAt));
    }
  }
  return { scoreDelta: scoreEvents.reduce((total, event) => total + event.points, 0), scoreEvents };
}

function scoreFailurePenalty(
  points: number,
  occurredAt: string,
): { readonly scoreDelta: number; readonly scoreEvents: KindScoreEvent[] } {
  return points === 0
    ? { scoreDelta: 0, scoreEvents: [] }
    : { scoreDelta: points, scoreEvents: [uptimeEvent(points, occurredAt)] };
}

function scorePhasedBonuses(
  scoring: PhasedPollingScoringMetadata,
  slotResults: readonly SlotResult[],
  prevState: DeploymentScoringState,
  occurredAt: string,
): {
  readonly scoreDelta: number;
  readonly scoreEvents: KindScoreEvent[];
  readonly awarded: Record<string, boolean>;
} {
  let scoreDelta = 0;
  const prevAwarded = prevState.bonusAwarded ?? {};
  const awarded: Record<string, boolean> = { ...prevAwarded };
  const scoreEvents: KindScoreEvent[] = [];
  for (const bonus of scoring.bonuses ?? []) {
    if ((bonus.once && prevAwarded[bonus.kind] === true) || !isBonusSatisfied(bonus, slotResults)) {
      continue;
    }
    scoreDelta += bonus.points;
    scoreEvents.push(uptimeEvent(bonus.points, occurredAt));
    if (bonus.once) awarded[bonus.kind] = true;
  }
  return { scoreDelta, scoreEvents, awarded };
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

function parsePostureFromBody(
  body: string | undefined,
): { readonly posture?: Record<string, boolean>; readonly platform?: string } | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { posture?: unknown; platform?: unknown };
    const posture = parsePostureMap(parsed.posture);
    const platform = typeof parsed.platform === "string" ? parsed.platform : undefined;
    if (!posture && !platform) return undefined;
    return {
      ...(posture ? { posture } : {}),
      ...(platform ? { platform } : {}),
    };
  } catch {
    return undefined;
  }
}

function parsePostureMap(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const posture: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "boolean") posture[key] = raw;
  }
  return Object.keys(posture).length > 0 ? posture : undefined;
}

function resolvePostureSnapshot(slotResults: readonly SlotResult[]): {
  readonly postureJson?: string;
} {
  const merged: Record<string, boolean> = {};
  for (const slot of slotResults) {
    if (slot.posture) Object.assign(merged, slot.posture);
  }
  return Object.keys(merged).length > 0 ? { postureJson: JSON.stringify(merged) } : {};
}

function resolvePlatformSnapshot(slotResults: readonly SlotResult[]): {
  readonly platform?: string;
} {
  const platforms = new Set(
    slotResults.flatMap((slot) => slot.posturePlatform ?? slot.platform ?? []),
  );
  if (platforms.size !== 1) return {};
  const [platform] = platforms;
  return platform ? { platform } : {};
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
