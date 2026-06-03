import { decodeLargeEnvValue } from "./env-encoding.js";

/**
 * 問題の `metadata.json:scoring` section の type-safe な parser (ADR-012 Phase 3.B 拡張)。
 *
 * 同じ shape を CDK synth 時 (`discoverProblemsScoring`) と Lambda runtime
 * (Portal `submit-flag`、Generic scoring dispatcher、`lookup.toView`) の両方で参照する
 * ため、ここに 1 箇所に集約する。SCHEMA.json と整合させる。
 *
 * ADR-012 Phase 3.B で 5 種の builtin kind をサポートする:
 *   - `flag`              — 1 回提出型 (Challenge)
 *   - `uptime-flat`       — 固定 endpoint 群を独立 probe、全 OK で配点 (legacy alias `uptime`)
 *   - `uptime-multi`      — N slot を AND probe、全 OK で配点 / 1 つでも fail で penalty
 *   - `phased-polling`    — 時刻で score rule が変わる、platform 分類 + bonus 対応
 *   - `attack-detection`  — stack output 内の counter 増分検知で配点
 */

/**
 * Issue #742 Phase 1: progressive hint の正式 shape。
 *
 *   - id: stable identifier (= 将来 DDB の `hintsRevealed` key に使う、 metadata 順序変更で
 *         reveal 記録が drift しないため)
 *   - content: 表示テキスト (= markdown 可)
 *   - penalty: reveal 時に `points` から減算する値 (positive integer、 0 許容)
 *
 * 後方互換: `hints: string[]` (= legacy v1 shape) は parser が
 * `{ id: \`hint-${index + 1}\`, content, penalty: 0 }` に変換する。 既存問題は 0 減点。
 *
 * 本 Phase 1 では schema migration + parser のみ。 reveal API / DDB persistence /
 * frontend UI / 減点 logic は Phase 2-4 で順次追加 (= Issue #742 の design 案 B/C/D に対応)。
 */
export interface ProgressiveHint {
  readonly id: string;
  readonly content: string;
  readonly penalty: number;
}

export interface FlagScoringMetadata {
  readonly kind: "flag";
  readonly flagOutputKey: string;
  readonly points: number;
  /**
   * Issue #817: 不正解 1 回ごとに score から減算する値 (= brute-force 対策)。
   * 未設定 / 0 は減点無し (= 既存問題と後方互換)。 team score は 0 未満にならず clamp。
   */
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

export interface UptimeFlatEndpoint {
  /** metadata.endpoints[].slot を参照する場合の slot 名。 */
  readonly slot?: string;
  /** [Legacy] slot を使わず CFn output から直接引く場合の OutputKey。 */
  readonly outputKey?: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
  /** endpoint 個別 points 上書き (= 省略時 parent.pointsPerSuccess を使う)。 */
  readonly pointsPerSuccess?: number;
}

/**
 * Issue #742 Phase 5: 全 5 種 builtin kind が hints を持てるよう共通 shape として
 * `ProgressiveHint[]` を再利用。 flag 以外でも metadata に hints を書けば
 * Phase 4 で導入した reveal UI が同じ動作で機能する (= phased-polling や
 * uptime 系でも 「攻撃に対する初動 hint」 を penalty 付きで開放できる)。
 */
export interface UptimeFlatScoringMetadata {
  /**
   * `uptime-flat` は新名。`uptime` は legacy SCHEMA (= Phase 1) との互換を保つための alias。
   * 採点 dispatcher / lookup view は両方を flat probe として扱う。
   */
  readonly kind: "uptime-flat" | "uptime";
  readonly endpoints: readonly UptimeFlatEndpoint[];
  readonly pointsPerSuccess: number;
  /** Issue #742 Phase 5: 全 5 種 builtin kind で hints を許容する共通 field。 */
  readonly hints?: readonly ProgressiveHint[];
}

export interface UptimeMultiProbedSlot {
  readonly slot: string;
  readonly path: string;
  readonly expectStatus: readonly number[];
}

export interface UptimeMultiScoringMetadata {
  readonly kind: "uptime-multi";
  readonly probedSlots: readonly UptimeMultiProbedSlot[];
  readonly pointsAllOk: number;
  readonly failurePenalty?: number;
  /**
   * [ADR-034 / #1666] 任意の attack-blocked bonus。 宣言すると、 競技者 stack が「攻撃をブロックした回数」を
   * 露出する CFn Output (`attackBlockedOutputKey`) の増分に応じて `pointsPerBlock` (既定 1) を加点する
   * (= 可用性採点に防御テストの加点を重ねる、 attack-detection と同じ counter-delta ロジック)。 省略で無効・後方互換。
   */
  readonly attackBlockedOutputKey?: string;
  readonly pointsPerBlock?: number;
  /** Issue #742 Phase 5: hints 共通 field。 */
  readonly hints?: readonly ProgressiveHint[];
}

export interface PhasedPollingPlatformRule {
  readonly points: number;
  readonly degradedPoints?: number;
}

export interface PhasedPollingResponsePenalty {
  /** 条件式 (DSL 文字列)。現状は `responseTimeMs > N` のみサポート (Phase 3.B)。 */
  readonly if: string;
  readonly points: number;
}

export interface PhasedPollingBonus {
  /** 既知の bonus kind は `all-slots-on-platforms` のみ (Phase 3.B)。 */
  readonly kind: string;
  readonly points: number;
  readonly once?: boolean;
  readonly platforms?: readonly string[];
}

export interface PhasedPollingScoringMetadata {
  readonly kind: "phased-polling";
  readonly intervalMinutes: number;
  readonly probe: {
    readonly metaPath: string;
    readonly scorePath: string;
  };
  readonly platformRules: Readonly<Record<string, PhasedPollingPlatformRule>>;
  readonly failurePenalty?: number;
  readonly responsePenalties?: readonly PhasedPollingResponsePenalty[];
  readonly bonuses?: readonly PhasedPollingBonus[];
  /** Issue #742 Phase 5: hints 共通 field。 */
  readonly hints?: readonly ProgressiveHint[];
}

export interface AttackDetectionCategory {
  readonly name: string;
  readonly pointsPerAttack?: number;
}

export interface AttackDetectionScoringMetadata {
  readonly kind: "attack-detection";
  readonly statsOutputKey: string;
  readonly pointsPerAttack: number;
  readonly categories?: readonly AttackDetectionCategory[];
  /** Issue #742 Phase 5: hints 共通 field。 */
  readonly hints?: readonly ProgressiveHint[];
}

export type ProblemScoringMetadata =
  | FlagScoringMetadata
  | UptimeFlatScoringMetadata
  | UptimeMultiScoringMetadata
  | PhasedPollingScoringMetadata
  | AttackDetectionScoringMetadata;

/**
 * 1 件の `scoring` value を ProblemScoringMetadata に narrow する。不正なら undefined。
 *
 * legacy `kind: "uptime"` (Phase 1 SCHEMA) は `uptime-flat` に正規化する (= Phase 3.B
 * dispatcher は新名で受ける)。dispatch 時にも `uptime` を `uptime-flat` と同列扱いに
 * したい migration 期の互換措置。
 */
export function parseScoringMetadata(value: unknown): ProblemScoringMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { kind?: unknown };
  if (v.kind === "flag") return parseFlag(value);
  if (v.kind === "uptime" || v.kind === "uptime-flat") return parseUptimeFlat(value, v.kind);
  if (v.kind === "uptime-multi") return parseUptimeMulti(value);
  if (v.kind === "phased-polling") return parsePhasedPolling(value);
  if (v.kind === "attack-detection") return parseAttackDetection(value);
  return undefined;
}

function parseFlag(value: unknown): FlagScoringMetadata | undefined {
  const f = value as {
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  if (typeof f.flagOutputKey !== "string") return undefined;
  if (typeof f.points !== "number" || !Number.isFinite(f.points) || f.points <= 0) return undefined;
  // Issue #817: wrongAnswerPenalty は optional。 不正な値 (= 負 / 非整数 / 非数値) は undefined に
  // clamp して fallback (= "no penalty" として安全側に倒す、 metadata typo で減点暴走を防ぐ)。
  const penaltyRaw = f.wrongAnswerPenalty;
  const wrongAnswerPenalty =
    typeof penaltyRaw === "number" &&
    Number.isFinite(penaltyRaw) &&
    penaltyRaw >= 0 &&
    Number.isInteger(penaltyRaw)
      ? penaltyRaw
      : undefined;
  return {
    kind: "flag",
    flagOutputKey: f.flagOutputKey,
    points: f.points,
    wrongAnswerPenalty,
    hints: parseHints(f.hints),
  };
}

/**
 * Issue #742 Phase 1: hints の v1 (string[]) と v2 (object[]) を共通 `ProgressiveHint[]` に
 * 正規化する。 不正な要素は filter で落とす (= test pin) ことで、 partial 不正でも全体 reject
 * しない (= 既存 metadata.json の hints 部分の typo が問題 deploy を止めないように)。
 *
 * v1 (legacy): `["text1", "text2"]` → `[{id: "hint-1", content: "text1", penalty: 0}, ...]`
 * v2 (new):    `[{id, content, penalty}]` → そのまま (= penalty が unsafe な値なら 0 にクランプ)
 */
function parseHints(value: unknown): readonly ProgressiveHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints = value
    .map((hint, index) => parseHint(hint, index))
    .filter((hint): hint is ProgressiveHint => hint !== undefined);
  return hints.length > 0 ? hints : undefined;
}

function parseHint(value: unknown, index: number): ProgressiveHint | undefined {
  if (typeof value === "string") {
    return { id: `hint-${index + 1}`, content: value, penalty: 0 };
  }
  if (!value || typeof value !== "object") return undefined;
  const hint = value as { id?: unknown; content?: unknown; penalty?: unknown };
  if (typeof hint.id !== "string" || hint.id.length === 0) return undefined;
  if (typeof hint.content !== "string" || hint.content.length === 0) return undefined;
  return { id: hint.id, content: hint.content, penalty: normalizeHintPenalty(hint.penalty) };
}

function normalizeHintPenalty(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseUptimeFlat(
  value: unknown,
  kindLiteral: "uptime" | "uptime-flat",
): UptimeFlatScoringMetadata | undefined {
  const u = value as { endpoints?: unknown; pointsPerSuccess?: unknown; hints?: unknown };
  if (!Array.isArray(u.endpoints) || u.endpoints.length === 0) return undefined;
  if (typeof u.pointsPerSuccess !== "number" || u.pointsPerSuccess <= 0) return undefined;
  const endpoints = u.endpoints
    .map(parseUptimeFlatEndpoint)
    .filter((endpoint): endpoint is UptimeFlatEndpoint => endpoint !== undefined);
  if (endpoints.length === 0) return undefined;
  // 入力 kind を保ったまま返す (= legacy `uptime` 採用 metadata の view 互換)。
  // dispatcher 側は両者を flat probe として処理する。
  const hints = parseHints(u.hints);
  return {
    kind: kindLiteral,
    endpoints,
    pointsPerSuccess: u.pointsPerSuccess,
    ...(hints ? { hints } : {}),
  };
}

function parseUptimeFlatEndpoint(value: unknown): UptimeFlatEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const endpoint = value as {
    slot?: unknown;
    outputKey?: unknown;
    path?: unknown;
    expectStatus?: unknown;
    pointsPerSuccess?: unknown;
  };
  if (typeof endpoint.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(endpoint.expectStatus);
  if (!expectStatus) return undefined;
  const slot = optionalNonEmptyString(endpoint.slot);
  const outputKey = optionalNonEmptyString(endpoint.outputKey);
  if (!slot && !outputKey) return undefined;
  return {
    ...(slot ? { slot } : {}),
    ...(outputKey ? { outputKey } : {}),
    path: endpoint.path,
    expectStatus,
    ...(isPositiveNumber(endpoint.pointsPerSuccess)
      ? { pointsPerSuccess: endpoint.pointsPerSuccess }
      : {}),
  };
}

function parseUptimeMulti(value: unknown): UptimeMultiScoringMetadata | undefined {
  const u = value as {
    probedSlots?: unknown;
    pointsAllOk?: unknown;
    failurePenalty?: unknown;
    attackBlockedOutputKey?: unknown;
    pointsPerBlock?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.probedSlots) || u.probedSlots.length === 0) return undefined;
  if (typeof u.pointsAllOk !== "number" || u.pointsAllOk <= 0) return undefined;
  const probedSlots = u.probedSlots
    .map(parseUptimeMultiSlot)
    .filter((slot): slot is UptimeMultiProbedSlot => slot !== undefined);
  if (probedSlots.length === 0) return undefined;
  const hints = parseHints(u.hints);
  // [ADR-034 / #1666] attack-blocked bonus は両 field が揃ったときだけ有効化 (= 片方欠けは無効)。
  const attackBonus =
    typeof u.attackBlockedOutputKey === "string" &&
    u.attackBlockedOutputKey.length > 0 &&
    typeof u.pointsPerBlock === "number" &&
    u.pointsPerBlock > 0
      ? { attackBlockedOutputKey: u.attackBlockedOutputKey, pointsPerBlock: u.pointsPerBlock }
      : undefined;
  return {
    kind: "uptime-multi",
    probedSlots,
    pointsAllOk: u.pointsAllOk,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(attackBonus ?? {}),
    ...(hints ? { hints } : {}),
  };
}

function parseUptimeMultiSlot(value: unknown): UptimeMultiProbedSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slot = value as { slot?: unknown; path?: unknown; expectStatus?: unknown };
  if (typeof slot.slot !== "string" || typeof slot.path !== "string") return undefined;
  const expectStatus = parseExpectedStatuses(slot.expectStatus);
  return expectStatus ? { slot: slot.slot, path: slot.path, expectStatus } : undefined;
}

function parsePhasedPolling(value: unknown): PhasedPollingScoringMetadata | undefined {
  const p = value as {
    intervalMinutes?: unknown;
    probe?: unknown;
    platformRules?: unknown;
    failurePenalty?: unknown;
    responsePenalties?: unknown;
    bonuses?: unknown;
    hints?: unknown;
  };
  if (typeof p.intervalMinutes !== "number" || p.intervalMinutes <= 0) return undefined;
  const probe = parsePhasedPollingProbe(p.probe);
  const platformRules = parsePlatformRules(p.platformRules);
  if (!probe) return undefined;
  if (Object.keys(platformRules).length === 0) return undefined;

  const responsePenalties = parseResponsePenalties(p.responsePenalties);
  const bonuses = parsePhasedPollingBonuses(p.bonuses);
  const hints = parseHints(p.hints);
  return {
    kind: "phased-polling",
    intervalMinutes: p.intervalMinutes,
    probe: { metaPath: probe.metaPath, scorePath: probe.scorePath },
    platformRules,
    ...(typeof p.failurePenalty === "number" ? { failurePenalty: p.failurePenalty } : {}),
    ...(responsePenalties.length > 0 ? { responsePenalties } : {}),
    ...(bonuses.length > 0 ? { bonuses } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parsePhasedPollingProbe(
  value: unknown,
): PhasedPollingScoringMetadata["probe"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const probe = value as { metaPath?: unknown; scorePath?: unknown };
  if (typeof probe.metaPath !== "string" || typeof probe.scorePath !== "string") {
    return undefined;
  }
  return { metaPath: probe.metaPath, scorePath: probe.scorePath };
}

function parsePlatformRules(value: unknown): Record<string, PhasedPollingPlatformRule> {
  if (!value || typeof value !== "object") return {};
  const rules: Record<string, PhasedPollingPlatformRule> = {};
  for (const [name, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRule || typeof rawRule !== "object") continue;
    const rule = rawRule as { points?: unknown; degradedPoints?: unknown };
    if (typeof rule.points !== "number") continue;
    rules[name] = {
      points: rule.points,
      ...(typeof rule.degradedPoints === "number" ? { degradedPoints: rule.degradedPoints } : {}),
    };
  }
  return rules;
}

function parseResponsePenalties(value: unknown): PhasedPollingResponsePenalty[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const penalty = entry as { if?: unknown; points?: unknown };
      if (typeof penalty.if !== "string" || typeof penalty.points !== "number") return undefined;
      return { if: penalty.if, points: penalty.points };
    })
    .filter((penalty): penalty is PhasedPollingResponsePenalty => penalty !== undefined);
}

function parsePhasedPollingBonuses(value: unknown): PhasedPollingBonus[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parsePhasedPollingBonus)
    .filter((bonus): bonus is PhasedPollingBonus => bonus !== undefined);
}

function parsePhasedPollingBonus(value: unknown): PhasedPollingBonus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bonus = value as { kind?: unknown; points?: unknown; once?: unknown; platforms?: unknown };
  if (typeof bonus.kind !== "string" || typeof bonus.points !== "number") return undefined;
  return {
    kind: bonus.kind,
    points: bonus.points,
    ...(typeof bonus.once === "boolean" ? { once: bonus.once } : {}),
    ...(Array.isArray(bonus.platforms)
      ? {
          platforms: bonus.platforms.filter(
            (platform): platform is string => typeof platform === "string",
          ),
        }
      : {}),
  };
}

function parseAttackDetection(value: unknown): AttackDetectionScoringMetadata | undefined {
  const a = value as {
    statsOutputKey?: unknown;
    pointsPerAttack?: unknown;
    categories?: unknown;
    hints?: unknown;
  };
  if (typeof a.statsOutputKey !== "string" || a.statsOutputKey.length === 0) return undefined;
  if (typeof a.pointsPerAttack !== "number" || a.pointsPerAttack <= 0) return undefined;
  const categories = parseAttackDetectionCategories(a.categories);
  const hints = parseHints(a.hints);
  return {
    kind: "attack-detection",
    statsOutputKey: a.statsOutputKey,
    pointsPerAttack: a.pointsPerAttack,
    ...(categories.length > 0 ? { categories } : {}),
    ...(hints ? { hints } : {}),
  };
}

function parseAttackDetectionCategories(value: unknown): AttackDetectionCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const category = entry as { name?: unknown; pointsPerAttack?: unknown };
      if (typeof category.name !== "string") return undefined;
      return {
        name: category.name,
        ...(typeof category.pointsPerAttack === "number"
          ? { pointsPerAttack: category.pointsPerAttack }
          : {}),
      };
    })
    .filter((category): category is AttackDetectionCategory => category !== undefined);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseExpectedStatuses(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const statuses = value.filter((status): status is number => typeof status === "number");
  return statuses.length > 0 ? statuses : undefined;
}

/**
 * Lambda env (`BATTLE_PROBLEMS_SCORING`) を decode し、`{ [problemId]: ProblemScoringMetadata }`
 * に narrow する。不正な entry (parse 失敗 / non-object / shape mismatch) は drop。
 *
 * Issue #810: 4 KB env-var 上限を回避するため、 CDK 側は gzip+base64 で env に積む
 * (= encodeLargeEnvValue)。 ここで decode → JSON parse する。 旧形式 (= plain JSON)
 * も backward compat で読める (= H4s prefix 判定)。
 */
export function parseScoringEnv(raw: string | undefined): Record<string, ProblemScoringMetadata> {
  const decoded = decodeLargeEnvValue(raw);
  if (!decoded) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ProblemScoringMetadata> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const cfg = parseScoringMetadata(v);
    if (cfg) out[k] = cfg;
  }
  return out;
}
