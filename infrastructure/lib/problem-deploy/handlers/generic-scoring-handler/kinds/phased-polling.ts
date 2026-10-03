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
  type ProbeFn,
  probeUrl,
  resolveActivePhase,
  uptimeEvent,
} from "../scoring-kernel.js";

/**
 * `phased-polling` kind (microservice-migration-battle 想定)。
 *
 * 動作:
 *   1. `nowMs - createdAt` から phaseElapsedMin を算出し、metadata.phases[] から active phase
 *      を確定 (= afterMinutes <= elapsed を満たす最後の phase)。
 *   2. 各 slot に対し `/meta` (= platform 自己申告) を probe。 ただし **hosting tier は自己申告を
 *      信用せず、 登録 URL の hostname から検証する** (Issue #2420 / `verifyPlatformTier`)。 URL が
 *      managed runtime (Lambda URL / API GW / App Runner / ELB) の host でない限り、 managed tier
 *      申告は `ec2` (untrusted) に格下げする。 SSM で env を書き換えて `/meta` に `lambda` と嘘を
 *      つく攻撃 (EC2 のまま managed 加点 + bonus) を engine 側で無効化する。
 *   3. 各 slot に対し `/score` (= phase.scorePathOverride があれば そちら) を probe。
 *   4. platformRules[<verifiedPlatform>] から rule を引き、
 *      - 通常時 → `points` を加算
 *      - phase で degraded 化されている platform → `degradedPoints` を加算 (= verified tier で keying)
 *      - rule が無い / probe 失敗 → `failurePenalty` を加算
 *   5. `responsePenalties` を slot 毎に適用 (= responseTimeMs 条件で減点)。
 *   6. `bonuses` を deployment 全体で評価 (= 例 all-slots-on-platforms /
 *      all-slots-distinct-platforms、 いずれも verified tier で判定。 `once: true` は前回
 *      awarded を `bonusAwarded.<bonus.kind>` で記録)。
 *
 * health は per-slot で 1 つの ok flag (= /score probe success) を `endpointsHealth` に
 * 入れる (participant-portal の applicationStatus aggregate と互換)。
 */
export async function runPhasedPollingKind(
  input: KindHandlerInput<PhasedPollingScoringMetadata>,
): Promise<KindResult> {
  const { deployment, scoring, slots, overrides, phases, nowMs, nowIso, prevState } = input;
  // [Issue #2441 / Phase B3] `deployment` flows from
  // `DeploymentsRepository.forEachCompleteDeploymentPage`, whose
  // `DeploymentRecord` never carries the physical `PK` (unused here beyond this
  // guard) — dropped; `problemId` alone is the correct precondition.
  if (!deployment.problemId) return noopKindResult();
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
  /**
   * URL-verified hosting tier used for **all scoring decisions** (platformRules lookup,
   * degraded keying, bonus). NOT the raw `/meta` self-report — see `verifyPlatformTier`
   * (Issue #2420). A managed-tier self-report that the registered URL host does not confirm
   * is downgraded to `ec2` here, so it can never earn managed-tier points or the bonus.
   */
  readonly verifiedPlatform: string | undefined;
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
  const placementMap = input.authoritativeEndpointPlacements
    ? new Map(input.authoritativeEndpointPlacements.map((placement) => [placement.slot, placement]))
    : undefined;
  return Promise.all(
    input.slots.map((slot) =>
      probePhasedSlot(
        slot,
        input.scoring,
        outputs,
        overrideMap.get(slot.slot),
        placementMap?.get(slot.slot),
        scorePath,
        input.probe ?? probeUrl,
      ),
    ),
  );
}

async function probePhasedSlot(
  slot: KindHandlerInput<PhasedPollingScoringMetadata>["slots"][number],
  scoring: PhasedPollingScoringMetadata,
  outputs: Record<string, string>,
  overrideUrl: string | undefined,
  authoritativePlacement:
    | { readonly effectiveUrl: string; readonly verifiedPlatform: string }
    | undefined,
  scorePath: string,
  probe: ProbeFn,
): Promise<SlotResult> {
  const outputValue = outputs[slot.default.key];
  const defaultUrl = outputValue
    ? resolveDefaultUrl(outputValue, slot.default.appendPath)
    : undefined;
  const baseUrl = authoritativePlacement?.effectiveUrl ?? overrideUrl ?? defaultUrl;
  if (!baseUrl) {
    return {
      slotName: slot.slot,
      baseUrl: undefined,
      verifiedPlatform: undefined,
      scoreOk: false,
      responseTimeMs: 0,
    };
  }
  const [metaProbe, scoreProbe, postureProbe] = await Promise.all([
    probe(joinUrl(baseUrl, scoring.probe.metaPath), { readBody: true }),
    probe(joinUrl(baseUrl, scorePath)),
    scoring.probe.posturePath
      ? probe(joinUrl(baseUrl, scoring.probe.posturePath), { readBody: true })
      : Promise.resolve(undefined),
  ]);
  const posture = parsePostureFromBody(postureProbe?.body);
  // Issue #2420: `/meta` is the self-report; the hosting tier we actually score is verified
  // against the registered URL host (an EC2-hosted service faking `lambda` is downgraded to ec2).
  const selfReported = parsePlatformFromMeta(metaProbe.body);
  return {
    slotName: slot.slot,
    baseUrl,
    verifiedPlatform:
      authoritativePlacement?.verifiedPlatform ?? verifyPlatformTier(selfReported, baseUrl),
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
  // Issue #2420: score against the URL-verified tier, never the raw `/meta` self-report.
  const platform = slot.verifiedPlatform;
  const platformRule = platform ? scoring.platformRules[platform] : undefined;
  if (!slot.scoreOk || !platform || !platformRule) {
    return scoreFailurePenalty(scoring.failurePenalty ?? 0, occurredAt);
  }
  const points =
    degradedPlatforms.has(platform) && platformRule.degradedPoints !== undefined
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
 * Issue #2420: managed hosting tiers whose points are worth cheating for. A self-report of one
 * of these that the registered URL host does not confirm is downgraded to `ec2` (untrusted).
 */
const MANAGED_TIERS: ReadonlySet<string> = new Set(["lambda", "ecs", "apprunner"]);

/**
 * Issue #2694: the full hosting-tier vocabulary. Only these self-reports are subject to being
 * overridden by the registered URL host — domain-specific platform keys (e.g. StackStack's
 * `posture-0`…`production`) are not hosting tiers and must survive an ALB or other managed
 * hostname sitting in front of the service.
 */
const HOSTING_TIERS: ReadonlySet<string> = new Set([...MANAGED_TIERS, "ec2"]);

/**
 * [Issue #2420] Derive the hosting tier from the registered URL host, never from the service's
 * `/meta` self-report. Managed AWS runtimes expose an unforgeable, AWS-owned hostname; a team
 * running on EC2 cannot mint one of these DNS names, so the tier cannot be faked by editing the
 * container's `PLATFORM` env:
 *
 *   - `*.lambda-url.<region>.on.aws`         → lambda (Lambda Function URL)
 *   - `*.execute-api.<region>.amazonaws.com` → lambda (API Gateway fronting Lambda)
 *   - `*.awsapprunner.com`                   → apprunner (App Runner service)
 *   - ELB DNS (`*.elb.…amazonaws.com`)       → ecs (load-balanced service)
 *
 * Any other host — an EC2 public DNS/IP, the `Ec2HostHint` output, or a custom domain — matches
 * no managed pattern and returns `undefined`. The caller (`verifyPlatformTier`) then treats a
 * managed self-report as untrusted (→ ec2), while a non-managed self-report passes through.
 */
function classifyManagedHost(host: string | undefined): "lambda" | "ecs" | "apprunner" | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  if (h.includes(".lambda-url.") || h.includes(".execute-api.")) return "lambda";
  if (h.endsWith(".awsapprunner.com")) return "apprunner";
  if (h.includes(".elb.") && h.endsWith(".amazonaws.com")) return "ecs";
  return undefined;
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * [Issue #2420] The hosting tier the engine will actually score. The registered URL host is
 * authoritative for hosting tiers:
 *
 *   - URL host matches a managed runtime + a **hosting-tier** (or missing) self-report → that
 *     derived tier (even if `/meta` disagrees — the URL wins).
 *   - URL host matches a managed runtime + a **domain-specific** self-report (StackStack's
 *     `posture-0`…`production` posture keys, which are not hosting tiers) → passed through
 *     unchanged (Issue #2694: an ALB in front of the service must not rewrite the posture key
 *     to `ecs`, which has no platformRule and would turn every healthy tick into
 *     failurePenalty).
 *   - No managed host + a **managed** self-report → `ec2` (a lie: EC2-hosted service claiming
 *     lambda/ecs/apprunner earns EC2-tier points at most and never the cross-platform bonus).
 *   - No managed host + a **non-managed** self-report (`ec2` or a domain-specific key) →
 *     passed through unchanged.
 *   - No managed host + no self-report → `undefined` (→ failurePenalty, preserved).
 *
 * The degraded phase (keyed on the tier via `switchPlatformToDegraded`) therefore also sees the
 * verified tier: a service left on EC2 while faking `lambda` is still degraded. Domain-specific
 * keys cannot spoof managed tiers either way: on a hosting-tier problem an unknown key matches
 * no platformRule and falls to failurePenalty.
 */
export function verifyPlatformTier(
  selfReported: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  const derived = classifyManagedHost(hostFromUrl(baseUrl));
  if (derived && (selfReported === undefined || HOSTING_TIERS.has(selfReported))) {
    return derived;
  }
  if (selfReported !== undefined && MANAGED_TIERS.has(selfReported)) return "ec2";
  return selfReported;
}

/**
 * `/meta` 応答 body から platform 識別子を抽出。 JSON で `{ "platform": "ec2" }` を期待する。
 * 任意形式 (= text/plain "ec2") も低リスク fallback として許容する。 これは **自己申告** であり、
 * hosting tier としての採点には `verifyPlatformTier` を通してからのみ使う (Issue #2420)。
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
    slotResults.flatMap((slot) => slot.posturePlatform ?? slot.verifiedPlatform ?? []),
  );
  if (platforms.size !== 1) return {};
  const [platform] = platforms;
  return platform ? { platform } : {};
}

/**
 * `responseTimeMs > N` のみサポートする。演算子を増やす場合は metadata parser と test も更新する。
 */
function evalResponseCondition(expr: string, responseTimeMs: number): boolean {
  const m = expr.match(/^responseTimeMs\s*>\s*(\d+)$/);
  if (!m) return false;
  const threshold = Number(m[1]);
  return responseTimeMs > threshold;
}

/**
 * 既知の bonus kind (いずれも **verified tier** で判定する — Issue #2420 / #2421):
 *   - `all-slots-on-platforms`: 全 slot が bonus.platforms 集合の platform に乗っている
 *     (= membership。 全 slot lambda でも成立)。
 *   - `all-slots-distinct-platforms` (Issue #2421): 全 slot が bonus.platforms 集合の platform に
 *     乗っており、 かつ **全 slot 互いに異なる** platform (= "one each"、 各 slot を別 managed
 *     runtime に分けたときだけ付与)。 distinctness は verified tier で評価するので `/meta` の
 *     偽装 (全部同じ実 tier を別名で申告) では成立しない。
 *
 * 不明な kind は false。
 */
function isBonusSatisfied(
  bonus: { readonly kind: string; readonly platforms?: readonly string[] },
  slotResults: readonly { readonly verifiedPlatform: string | undefined }[],
): boolean {
  if (bonus.kind === "all-slots-on-platforms") {
    return allSlotsOnPlatforms(bonus.platforms, slotResults);
  }
  if (bonus.kind === "all-slots-distinct-platforms") {
    return allSlotsDistinctPlatforms(bonus.platforms, slotResults);
  }
  return false;
}

function allSlotsOnPlatforms(
  platforms: readonly string[] | undefined,
  slotResults: readonly { readonly verifiedPlatform: string | undefined }[],
): boolean {
  if (!platforms || platforms.length === 0) return false;
  const allowed = new Set(platforms);
  return slotResults.every(
    (r) => r.verifiedPlatform !== undefined && allowed.has(r.verifiedPlatform),
  );
}

/**
 * [Issue #2421] 全 slot が `platforms` 集合に属し、 かつ pairwise distinct なら true。 空 slot 集合は
 * false (= "one each" を満たしようがない)。 判定は verified tier (Issue #2420) を用いる。
 */
function allSlotsDistinctPlatforms(
  platforms: readonly string[] | undefined,
  slotResults: readonly { readonly verifiedPlatform: string | undefined }[],
): boolean {
  if (!platforms || platforms.length === 0 || slotResults.length === 0) return false;
  const allowed = new Set(platforms);
  const seen = new Set<string>();
  for (const r of slotResults) {
    const tier = r.verifiedPlatform;
    if (tier === undefined || !allowed.has(tier) || seen.has(tier)) return false;
    seen.add(tier);
  }
  return true;
}
