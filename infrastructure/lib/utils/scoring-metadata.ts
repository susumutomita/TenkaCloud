import { decodeLargeEnvValue } from "./env-encoding.js";

/**
 * 問題の `metadata.json:scoring` section の type-safe な parser (ADR-012 Phase 3.B 拡張)。
 *
 * 同じ shape を CDK synth 時 (`discoverProblemsScoring`) と Lambda runtime
 * (Portal `submit-flag`、Generic scoring dispatcher、`lookup.toView`) の両方で参照する
 * ため、ここに 1 箇所に集約する。SCHEMA.json と整合させる。
 *
 * ADR-012 Phase 3.B の 5 種 + #1796 拡張の multi-flag = 6 種の builtin kind をサポートする:
 *   - `flag`              — 1 回提出型 (Challenge、提出採点)
 *   - `multi-flag`        — 1 問に N 個の独立 flag、各個別提出で部分点 (#1796、提出採点)
 *   - `uptime-flat`       — 固定 endpoint 群を独立 probe、全 OK で配点 (legacy alias `uptime`)
 *   - `uptime-multi`      — N slot を AND probe、全 OK で配点 / 1 つでも fail で penalty
 *   - `phased-polling`    — 時刻で score rule が変わる、platform 分類 + bonus 対応
 *   - `attack-detection`  — stack output 内の counter 増分検知で配点
 *
 * `flag` / `multi-flag` は提出採点 (participant-handler の submit-flag)、 残り 4 種は generic
 * scoring Lambda の polling 採点。
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

/**
 * Issue #1796: multi-flag kind の sub-flag 1 件。 1 問題に N 個の独立 flag を持たせ、
 * 競技者が各 flag を別々に提出して個別加点される (= ストーリー連作 Challenge を 1 問に統合)。
 *
 *   - id: 問題内で unique な stable identifier (= 解済 flag id 集合 `solvedFlagIds` の key、
 *         submit-flag request の flagId と一致させる。 metadata 順序変更で記録が drift しない)
 *   - label: portal UI に出す表示名 (= 「Ep01: Reachability」 等)
 *   - flagOutputKey: 正解値を引く CFn Output key (= 単一 flag kind の flagOutputKey と同義)
 *   - points: 正解時の加点
 *   - wrongAnswerPenalty: 不正解 1 回ごとの減点 (= flag ごとに独立、 単一 flag kind と同契約)
 *   - hints: per-flag progressive hint (= 型は確保するが reveal 経路は本 Phase 未対応)
 */
export interface MultiFlagEntry {
  readonly id: string;
  readonly label: string;
  readonly flagOutputKey: string;
  readonly points: number;
  readonly wrongAnswerPenalty?: number;
  readonly hints?: readonly ProgressiveHint[];
}

/**
 * Issue #1796: multi-flag kind。 N 個の独立 flag を 1 問題に持たせる。 各 flag の合計が
 * 問題の満点になる (= 部分点)。 単一 flag kind は不変で温存し、 multi-flag は新規 opt-in。
 */
export interface MultiFlagScoringMetadata {
  readonly kind: "multi-flag";
  readonly flags: readonly MultiFlagEntry[];
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
  /**
   * health-check 失敗 tick の score delta。 省略時 0 (= 加点しないだけ、 従来挙動)。 **負値で減点**
   * (= uptime-multi.failurePenalty と同契約)。 Battle で「落とされたら減点」を opt-in したい問題が指定する
   * (例: -100)。 endpoint が 1 つでも fail した tick に加算される。
   */
  readonly failurePenalty?: number;
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
   * [ADR-034 / #1666] 任意の attack-blocked bonus。 宣言すると採点 tick が `slot` の base URL + `path` を
   * **live probe** し (= 静的 CFn output でなく、 走っているアプリの counter endpoint を読む)、 応答 body を
   * ブロック回数 (整数) として parse して、 前回からの増分に `pointsPerBlock` を掛けて加点する (= 防御の成否を
   * 可用性採点に重ねる。 attack-detection の counter-delta + cap を共有)。 省略で無効・後方互換。
   */
  readonly attackBlocked?: {
    readonly slot: string;
    readonly path: string;
    readonly pointsPerBlock: number;
  };
  /**
   * [ADR-034 / #1666] 任意の attack-probes (= 防御テスト)。 採点 tick が各 probe の `slot`+`path` へ
   * 攻撃 payload を送り (例: SQLi injection を POST)、 応答ステータスが `vulnerableStatus` に含まれれば
   * (= 防御が破れた) `penalty` を減点する。 防御できているチームは減点 0。 app 計装不要・採点側で判定 (=
   * scorer が攻撃して結果で採点)。 省略で無効・後方互換。 unreachable は減点しない (= 可用性は probedSlots が見る)。
   */
  readonly attackProbes?: readonly {
    readonly slot: string;
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly body?: string;
    readonly vulnerableStatus: readonly number[];
    readonly penalty: number;
  }[];
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
  | MultiFlagScoringMetadata
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
  if (v.kind === "multi-flag") return parseMultiFlag(value);
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
  return {
    kind: "flag",
    flagOutputKey: f.flagOutputKey,
    points: f.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(f.wrongAnswerPenalty),
    hints: parseHints(f.hints),
  };
}

/**
 * Issue #817: wrongAnswerPenalty は optional。 不正な値 (= 負 / 非整数 / 非数値) は undefined に
 * clamp して fallback (= "no penalty" として安全側に倒す、 metadata typo で減点暴走を防ぐ)。
 * Issue #1796: multi-flag の per-flag penalty も同契約を共有するため helper に切り出す。
 */
function clampWrongAnswerPenalty(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * Issue #1796: multi-flag kind を narrow する。
 *
 * **partial-drop しない (= 1 つでも entry が不正なら object 全体を undefined に倒す)**。
 * hints (parseHints) や uptime-flat の endpoints は不正要素を filter で落としても全体配点は
 * 変わらないが、 multi-flag の flags[] は 1 件 = 問題の満点の一部 (= 部分点)。 不正 entry を
 * 黙って drop すると問題の総得点が無言で変わり (= 競技者ごとに満点が違う事故)、 採点の公平性が
 * 崩れる。 同様に id / flagOutputKey の重複も総得点や採点照合を壊すので reject する (= fail loud)。
 */
function parseMultiFlag(value: unknown): MultiFlagScoringMetadata | undefined {
  const m = value as { flags?: unknown };
  if (!Array.isArray(m.flags) || m.flags.length === 0) return undefined;

  const flags: MultiFlagEntry[] = [];
  const seenIds = new Set<string>();
  const seenOutputKeys = new Set<string>();
  for (const raw of m.flags) {
    const entry = parseMultiFlagEntry(raw);
    if (!entry) return undefined; // 1 件でも不正なら全体 reject (= 部分点が無言で変わるのを防ぐ)
    if (seenIds.has(entry.id) || seenOutputKeys.has(entry.flagOutputKey)) return undefined;
    seenIds.add(entry.id);
    seenOutputKeys.add(entry.flagOutputKey);
    flags.push(entry);
  }
  return { kind: "multi-flag", flags };
}

function parseMultiFlagEntry(value: unknown): MultiFlagEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const e = value as {
    id?: unknown;
    label?: unknown;
    flagOutputKey?: unknown;
    points?: unknown;
    wrongAnswerPenalty?: unknown;
    hints?: unknown;
  };
  const id = optionalNonEmptyString(e.id);
  const label = optionalNonEmptyString(e.label);
  const flagOutputKey = optionalNonEmptyString(e.flagOutputKey);
  if (!id || !label || !flagOutputKey) return undefined;
  if (typeof e.points !== "number" || !Number.isFinite(e.points) || e.points <= 0) return undefined;
  const hints = parseHints(e.hints);
  return {
    id,
    label,
    flagOutputKey,
    points: e.points,
    wrongAnswerPenalty: clampWrongAnswerPenalty(e.wrongAnswerPenalty),
    ...(hints ? { hints } : {}),
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
  const u = value as {
    endpoints?: unknown;
    pointsPerSuccess?: unknown;
    failurePenalty?: unknown;
    hints?: unknown;
  };
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
    // 失敗時の減点 (opt-in、 負値)。 uptime-multi.failurePenalty と同じく number のときだけ採用。
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
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
    attackBlocked?: unknown;
    attackProbes?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.probedSlots) || u.probedSlots.length === 0) return undefined;
  if (typeof u.pointsAllOk !== "number" || u.pointsAllOk <= 0) return undefined;
  const probedSlots = u.probedSlots
    .map(parseUptimeMultiSlot)
    .filter((slot): slot is UptimeMultiProbedSlot => slot !== undefined);
  if (probedSlots.length === 0) return undefined;
  const hints = parseHints(u.hints);
  const attackBlocked = parseAttackBlocked(u.attackBlocked);
  const attackProbes = Array.isArray(u.attackProbes)
    ? u.attackProbes
        .map(parseAttackProbe)
        .filter((p): p is NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] => !!p)
    : undefined;
  return {
    kind: "uptime-multi",
    probedSlots,
    pointsAllOk: u.pointsAllOk,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(attackBlocked ? { attackBlocked } : {}),
    ...(attackProbes && attackProbes.length > 0 ? { attackProbes } : {}),
    ...(hints ? { hints } : {}),
  };
}

/** [ADR-034 / #1666] attack-probe 1 件を fail-safe に parse。 slot/path/vulnerableStatus/penalty 必須。 */
function parseAttackProbe(
  value: unknown,
): NonNullable<UptimeMultiScoringMetadata["attackProbes"]>[number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as {
    slot?: unknown;
    path?: unknown;
    method?: unknown;
    body?: unknown;
    vulnerableStatus?: unknown;
    penalty?: unknown;
  };
  if (typeof p.slot !== "string" || p.slot.length === 0) return undefined;
  if (typeof p.path !== "string" || p.path.length === 0) return undefined;
  if (typeof p.penalty !== "number" || p.penalty <= 0) return undefined;
  const vulnerableStatus = Array.isArray(p.vulnerableStatus)
    ? p.vulnerableStatus.filter((s): s is number => typeof s === "number")
    : [];
  if (vulnerableStatus.length === 0) return undefined;
  return {
    slot: p.slot,
    path: p.path,
    ...(p.method === "POST" || p.method === "GET" ? { method: p.method } : {}),
    ...(typeof p.body === "string" ? { body: p.body } : {}),
    vulnerableStatus,
    penalty: p.penalty,
  };
}

/** [ADR-034 / #1666] attack-blocked bonus は slot/path/pointsPerBlock が全て揃ったときだけ有効化。 */
function parseAttackBlocked(
  value: unknown,
): UptimeMultiScoringMetadata["attackBlocked"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const a = value as { slot?: unknown; path?: unknown; pointsPerBlock?: unknown };
  if (typeof a.slot !== "string" || a.slot.length === 0) return undefined;
  if (typeof a.path !== "string" || a.path.length === 0) return undefined;
  if (typeof a.pointsPerBlock !== "number" || a.pointsPerBlock <= 0) return undefined;
  return { slot: a.slot, path: a.path, pointsPerBlock: a.pointsPerBlock };
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
