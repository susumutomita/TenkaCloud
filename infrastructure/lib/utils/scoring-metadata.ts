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
  const f = value as { flagOutputKey?: unknown; points?: unknown; hints?: unknown };
  if (typeof f.flagOutputKey !== "string") return undefined;
  if (typeof f.points !== "number" || !Number.isFinite(f.points) || f.points <= 0) return undefined;
  return {
    kind: "flag",
    flagOutputKey: f.flagOutputKey,
    points: f.points,
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
  const hints: ProgressiveHint[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw === "string") {
      hints.push({ id: `hint-${index + 1}`, content: raw, penalty: 0 });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as { id?: unknown; content?: unknown; penalty?: unknown };
    if (typeof obj.id !== "string" || obj.id.length === 0) continue;
    if (typeof obj.content !== "string" || obj.content.length === 0) continue;
    const penalty =
      typeof obj.penalty === "number" && Number.isFinite(obj.penalty) && obj.penalty >= 0
        ? Math.floor(obj.penalty)
        : 0;
    hints.push({ id: obj.id, content: obj.content, penalty });
  }
  return hints.length > 0 ? hints : undefined;
}

function parseUptimeFlat(
  value: unknown,
  kindLiteral: "uptime" | "uptime-flat",
): UptimeFlatScoringMetadata | undefined {
  const u = value as { endpoints?: unknown; pointsPerSuccess?: unknown; hints?: unknown };
  if (!Array.isArray(u.endpoints) || u.endpoints.length === 0) return undefined;
  if (typeof u.pointsPerSuccess !== "number" || u.pointsPerSuccess <= 0) return undefined;
  const endpoints: UptimeFlatEndpoint[] = [];
  for (const entry of u.endpoints) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      slot?: unknown;
      outputKey?: unknown;
      path?: unknown;
      expectStatus?: unknown;
      pointsPerSuccess?: unknown;
    };
    if (typeof e.path !== "string") continue;
    if (!Array.isArray(e.expectStatus) || e.expectStatus.length === 0) continue;
    const expectStatus = e.expectStatus.filter((s): s is number => typeof s === "number");
    if (expectStatus.length === 0) continue;
    // slot か outputKey のどちらかが要る (= effective URL を解決するため)。
    const hasSlot = typeof e.slot === "string" && e.slot.length > 0;
    const hasOutputKey = typeof e.outputKey === "string" && e.outputKey.length > 0;
    if (!hasSlot && !hasOutputKey) continue;
    endpoints.push({
      ...(hasSlot ? { slot: e.slot as string } : {}),
      ...(hasOutputKey ? { outputKey: e.outputKey as string } : {}),
      path: e.path,
      expectStatus,
      ...(typeof e.pointsPerSuccess === "number" && e.pointsPerSuccess > 0
        ? { pointsPerSuccess: e.pointsPerSuccess }
        : {}),
    });
  }
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

function parseUptimeMulti(value: unknown): UptimeMultiScoringMetadata | undefined {
  const u = value as {
    probedSlots?: unknown;
    pointsAllOk?: unknown;
    failurePenalty?: unknown;
    hints?: unknown;
  };
  if (!Array.isArray(u.probedSlots) || u.probedSlots.length === 0) return undefined;
  if (typeof u.pointsAllOk !== "number" || u.pointsAllOk <= 0) return undefined;
  const probedSlots: UptimeMultiProbedSlot[] = [];
  for (const entry of u.probedSlots) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { slot?: unknown; path?: unknown; expectStatus?: unknown };
    if (typeof e.slot !== "string" || typeof e.path !== "string") continue;
    if (!Array.isArray(e.expectStatus) || e.expectStatus.length === 0) continue;
    const expectStatus = e.expectStatus.filter((s): s is number => typeof s === "number");
    if (expectStatus.length === 0) continue;
    probedSlots.push({ slot: e.slot, path: e.path, expectStatus });
  }
  if (probedSlots.length === 0) return undefined;
  const hints = parseHints(u.hints);
  return {
    kind: "uptime-multi",
    probedSlots,
    pointsAllOk: u.pointsAllOk,
    ...(typeof u.failurePenalty === "number" ? { failurePenalty: u.failurePenalty } : {}),
    ...(hints ? { hints } : {}),
  };
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
  if (!p.probe || typeof p.probe !== "object") return undefined;
  const probe = p.probe as { metaPath?: unknown; scorePath?: unknown };
  if (typeof probe.metaPath !== "string" || typeof probe.scorePath !== "string") return undefined;
  if (!p.platformRules || typeof p.platformRules !== "object") return undefined;

  const platformRules: Record<string, PhasedPollingPlatformRule> = {};
  for (const [name, rule] of Object.entries(p.platformRules as Record<string, unknown>)) {
    if (!rule || typeof rule !== "object") continue;
    const r = rule as { points?: unknown; degradedPoints?: unknown };
    if (typeof r.points !== "number") continue;
    platformRules[name] = {
      points: r.points,
      ...(typeof r.degradedPoints === "number" ? { degradedPoints: r.degradedPoints } : {}),
    };
  }
  if (Object.keys(platformRules).length === 0) return undefined;

  const responsePenalties: PhasedPollingResponsePenalty[] = [];
  if (Array.isArray(p.responsePenalties)) {
    for (const entry of p.responsePenalties) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { if?: unknown; points?: unknown };
      if (typeof e.if !== "string" || typeof e.points !== "number") continue;
      responsePenalties.push({ if: e.if, points: e.points });
    }
  }

  const bonuses: PhasedPollingBonus[] = [];
  if (Array.isArray(p.bonuses)) {
    for (const entry of p.bonuses) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as {
        kind?: unknown;
        points?: unknown;
        once?: unknown;
        platforms?: unknown;
      };
      if (typeof e.kind !== "string" || typeof e.points !== "number") continue;
      bonuses.push({
        kind: e.kind,
        points: e.points,
        ...(typeof e.once === "boolean" ? { once: e.once } : {}),
        ...(Array.isArray(e.platforms)
          ? { platforms: e.platforms.filter((s): s is string => typeof s === "string") }
          : {}),
      });
    }
  }

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

function parseAttackDetection(value: unknown): AttackDetectionScoringMetadata | undefined {
  const a = value as {
    statsOutputKey?: unknown;
    pointsPerAttack?: unknown;
    categories?: unknown;
    hints?: unknown;
  };
  if (typeof a.statsOutputKey !== "string" || a.statsOutputKey.length === 0) return undefined;
  if (typeof a.pointsPerAttack !== "number" || a.pointsPerAttack <= 0) return undefined;
  const categories: AttackDetectionCategory[] = [];
  if (Array.isArray(a.categories)) {
    for (const entry of a.categories) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { name?: unknown; pointsPerAttack?: unknown };
      if (typeof e.name !== "string") continue;
      categories.push({
        name: e.name,
        ...(typeof e.pointsPerAttack === "number" ? { pointsPerAttack: e.pointsPerAttack } : {}),
      });
    }
  }
  const hints = parseHints(a.hints);
  return {
    kind: "attack-detection",
    statsOutputKey: a.statsOutputKey,
    pointsPerAttack: a.pointsPerAttack,
    ...(categories.length > 0 ? { categories } : {}),
    ...(hints ? { hints } : {}),
  };
}

/**
 * Lambda env (`BATTLE_PROBLEMS_SCORING`) を decode し、`{ [problemId]: ProblemScoringMetadata }`
 * に narrow する。不正な entry (parse 失敗 / non-object / shape mismatch) は drop。
 */
export function parseScoringEnv(raw: string | undefined): Record<string, ProblemScoringMetadata> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
