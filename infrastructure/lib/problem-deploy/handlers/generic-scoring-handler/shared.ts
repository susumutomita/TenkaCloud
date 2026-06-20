import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
import {
  type ProblemDisruptionEntry,
  parseDisruptionsCatalogEnv,
} from "../../../utils/discover-problems-catalog.js";
import { type ProblemEndpointSlot, parseEndpointsEnv } from "../../../utils/endpoints-metadata.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import { isSsrfSafeUrl } from "../shared/ssrf-guard.js";

/**
 * Generic scoring dispatcher Lambda (ADR-012 Phase 3.B) の env / SDK clients を 1 まとまりで
 * 抱える resources。caller (= test) からは `buildSharedResources()` を呼んで取得する。
 *
 * 5 種の builtin kind handler はすべてこの resources を share する。state map (= per-deployment
 * の bonus once tracking / attack counter) は Lambda 起動の 1 invocation で確定する一時的な
 * memo (= DDB へ並列書き出し前提)。
 */
export interface GenericScoringSharedResources {
  readonly ddb: DynamoDBDocumentClient;
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly endpointsTableName: string;
  readonly problemsScoring: Record<string, ProblemScoringMetadata>;
  readonly problemsEndpoints: Record<string, readonly ProblemEndpointSlot[]>;
  /** [#1422] condition-triggered disruption の catalog (= `BATTLE_PROBLEMS_DISRUPTIONS` env)。 */
  readonly problemsDisruptions: Record<string, readonly ProblemDisruptionEntry[]>;
  /** [ADR-033 / #1665] operator-fired disruption の audit table (= 採点効果の active window 解決、 "" で無効)。 */
  readonly disruptionsTableName: string;
  /** [#1422] condition-triggered fire の publish 先 event bus (= 空なら発火 skip)。 */
  readonly eventBusName: string;
  readonly events: EventBridgeClient;
  /**
   * [ADR-026/027/032 / #1410-1412] 非 AWS runtime status reconciler が per-team credential を解決し
   * adapter を組むための env / SSM client / AppRun base URL override。 absent runtime (= AWS) では未使用。
   */
  readonly env: string;
  readonly ssm: SSMClient;
  readonly sakuraAppRunBaseUrl?: string;
}

export function buildSharedResources(): GenericScoringSharedResources {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    endpointsTableName: getEnv("PROBLEM_ENDPOINTS_TABLE_NAME"),
    problemsScoring: parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
    problemsDisruptions: parseDisruptionsCatalogEnv(process.env.BATTLE_PROBLEMS_DISRUPTIONS),
    // [ADR-033 / #1665] operator-fired disruption の audit 行を読む table (= 採点効果の active window 解決)。
    // 未配線 (= "") なら operator-fired effect は無効 (condition-triggered のみ、 後方互換)。
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    eventBusName: process.env.DEPLOY_EVENT_BUS_NAME ?? "",
    events: new EventBridgeClient({}),
    // 非 AWS reconciler 専用 (= AWS only の運用では未使用)。 unset でも throw させず空文字に倒す
    // (= 既存 scoring tick / test を壊さない)。 本番 Lambda は DEPLOY_ENVIRONMENT を必ず注入する。
    env: process.env.DEPLOY_ENVIRONMENT ?? "",
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

/**
 * 1 deployment 分の永続化 state (= 5 kind に跨る per-team scoring state)。
 * - `bonusAwarded`: phased-polling の `bonus.once=true` で重複加算しないための flag map。
 *   key は bonus.kind 値 (例: "all-slots-on-platforms")。
 * - `attackCount`: attack-detection で前回 counter 値を保持し、差分加算する。
 *
 * DDB の deployment.SK="META" 行に JSON 文字列で保存し、次 tick で read-through で復元する。
 * 失敗時 (= 壊れた JSON) は空 state にフォールバック (= 安全側、最初の tick は 0 加算)。
 */
/**
 * [ADR-033 / #1665] active な採点効果の 1 件。 disruption が fire したとき (condition-triggered) に
 * `expiresAtMs` 付きで記録し、 採点 tick が window 内の各 tick で `points` を減点する。 期限切れは prune。
 */
export interface ActiveDisruptionEffect {
  readonly disruptionId: string;
  readonly points: number;
  readonly expiresAtMs: number;
}

export interface DeploymentScoringState {
  readonly bonusAwarded?: Readonly<Record<string, boolean>>;
  readonly attackCount?: number;
  /**
   * [#1422] 既に condition-triggered で発火済みの disruptionId 群。 OR semantics + 一度発火したら
   * 以降抑制する idempotency record (= ADR-013 OQ#5)。 publish 成功後にだけ追記する。
   */
  readonly firedDisruptions?: readonly string[];
  /**
   * [ADR-033 / #1665] active な採点効果 (= fire 済 disruption の減点 window)。 各 tick で適用し、
   * `expiresAtMs <= now` のものは prune する。
   */
  readonly activeEffects?: readonly ActiveDisruptionEffect[];
}

/** [ADR-033] JSON から ActiveDisruptionEffect 配列を fail-safe に復元する。 不正要素は drop。 */
function parseActiveEffects(raw: unknown): readonly ActiveDisruptionEffect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const effects: ActiveDisruptionEffect[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const { disruptionId, points, expiresAtMs } = e as Record<string, unknown>;
    if (
      typeof disruptionId === "string" &&
      disruptionId.length > 0 &&
      typeof points === "number" &&
      Number.isFinite(points) &&
      typeof expiresAtMs === "number" &&
      Number.isFinite(expiresAtMs)
    ) {
      effects.push({ disruptionId, points, expiresAtMs });
    }
  }
  return effects.length > 0 ? effects : undefined;
}

export function parseScoringState(raw: string | undefined): DeploymentScoringState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const p = parsed as { bonusAwarded?: unknown; attackCount?: unknown };
  const bonusAwarded =
    p.bonusAwarded && typeof p.bonusAwarded === "object" && !Array.isArray(p.bonusAwarded)
      ? Object.fromEntries(
          Object.entries(p.bonusAwarded as Record<string, unknown>).filter(
            ([, v]) => v === true,
          ) as Array<[string, true]>,
        )
      : undefined;
  const attackCount = typeof p.attackCount === "number" ? p.attackCount : undefined;
  const firedRaw = (parsed as { firedDisruptions?: unknown }).firedDisruptions;
  const firedDisruptions = Array.isArray(firedRaw)
    ? firedRaw.filter((s): s is string => typeof s === "string")
    : undefined;
  const activeEffects = parseActiveEffects((parsed as { activeEffects?: unknown }).activeEffects);
  return {
    ...(bonusAwarded ? { bonusAwarded } : {}),
    ...(attackCount !== undefined ? { attackCount } : {}),
    ...(firedDisruptions && firedDisruptions.length > 0 ? { firedDisruptions } : {}),
    ...(activeEffects ? { activeEffects } : {}),
  };
}

/**
 * [#1422] `phaseElapsedMin` から active phase を確定する。 phases[] は afterMinutes 昇順 (= metadata
 * 規約) を前提に、 elapsed 以下の最後の entry を返す。 順序保証されない場合に備えて defensive に sort。
 *
 * phased-polling kind と condition-trigger 評価 (disruption-triggers.ts) で共有する (= DRY)。
 */
export function resolveActivePhase(
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
 * Lambda 内に outbound HTTP を発行する probe helper (ADR-012 Phase 3.B)。`handler-must-not-call-fetch`
 * lint は本 module を generic-scoring-handler/ 配下に置くことで namespace 緩和される
 * (= health-check-handler 同型の "scoring engine は probe 用 fetch を許可する" 例外)。
 *
 * `responseTimeMs` を返すため `phased-polling` の `responsePenalties` 評価が可能。
 */
export interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly responseTimeMs: number;
  readonly body?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 4_096;

export async function probeUrl(
  url: string,
  options: {
    readonly expectStatus?: readonly number[];
    readonly timeoutMs?: number;
    readonly readBody?: boolean;
    /** [ADR-034 / #1666] attack-probe 用。 既定 GET。 */
    readonly method?: "GET" | "POST";
    /** POST body (= 攻撃 payload)。 method=POST + body 指定時に content-type: application/json で送る。 */
    readonly body?: string;
  } = {},
): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const start = Date.now();
  // SSRF defense-in-depth: metadata-supplied path が絶対 URL として host を上書きする経路
  // (joinUrl) は write-time validation を通らないため、 probe 直前にも blocklist host を弾く。
  if (!isSsrfSafeUrl(url)) {
    clearTimeout(timer);
    return { ok: false, status: undefined, responseTimeMs: Date.now() - start };
  }
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      signal: ctrl.signal,
      ...(options.method === "POST" && options.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: options.body }
        : {}),
    });
    const responseTimeMs = Date.now() - start;
    // redirect 追従で blocklist host (IMDS 等) に着地した応答は body を読まず not-ok 扱いにする
    // (= write-time check を redirect で bypass されても内部応答を reflect しない)。
    const finalUrl = res.url;
    const safeFinal = !finalUrl || isSsrfSafeUrl(finalUrl);
    const ok =
      safeFinal &&
      (options.expectStatus
        ? options.expectStatus.includes(res.status)
        : res.status >= 200 && res.status < 300);
    let body: string | undefined;
    if (options.readBody && ok) {
      // body 読みは bonus / phased-polling の platform 判定で要る。応答を stream で読みつつ
      // MAX_BODY_BYTES で打ち切り、 巨大応答による Lambda の OOM を防ぐ (#1387)。
      body = await readCappedBody(res, MAX_BODY_BYTES);
    }
    return {
      ok,
      status: res.status,
      responseTimeMs,
      ...(body !== undefined ? { body } : {}),
    };
  } catch {
    return { ok: false, status: undefined, responseTimeMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 応答 body を最大 `maxBytes` まで読んで decode する。stream (`res.body`) があれば chunk 単位で
 * 読み、 上限到達時点で stream を cancel する (= `res.text()` の全文バッファによる OOM を回避)。
 * stream を持たない応答 (= test の fetch mock 等、 既に in-memory な小 body) は `res.text()` で
 * 取得してから切り詰める fallback。
 */
async function readCappedBody(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const stream = res.body;
    if (stream && typeof stream.getReader === "function") {
      const bytes = await drainStreamCapped(stream.getReader(), maxBytes);
      return new TextDecoder().decode(bytes);
    }
    // Stream 非対応の応答 (= test の fetch mock 等) のみ fallback。
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return undefined;
  }
}

/** ReadableStream を最大 maxBytes まで読み、 上限到達で cancel して切り詰めた bytes を返す。 */
async function drainStreamCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.length > maxBytes ? merged.subarray(0, maxBytes) : merged;
}

/**
 * base URL に relative path を append する (= scoring metadata の `path` 規約と整合)。
 *
 * `appendPath` (= 例 `/users`) が base に含まれているケースで、 さらに `path` (= 例 `/score`)
 * を **積み増す** semantics を提供する。 WHATWG URL の `new URL("/score", "...com/users/")` は
 * `/score` を absolute path として再 resolve して `/users` を drop するため、 本関数では
 * 「path 先頭の `/` を相対の文脈ヒントとして無視する」 規約で path-style join する。
 *
 * 例:
 *   joinUrl("https://x.example.com/users", "/score")    → "https://x.example.com/users/score"
 *   joinUrl("https://x.example.com/users/", "/score")   → "https://x.example.com/users/score"
 *   joinUrl("https://x.example.com", "https://other/x") → "https://other/x" (絶対 URL は override)
 *   joinUrl("https://x.example.com", "")                → "https://x.example.com"
 */
export function joinUrl(base: string, relPath: string): string {
  if (!relPath) return base;
  // path 先頭が scheme なら 絶対 URL として採用 (= override)。 try URL() で判定する。
  try {
    return new URL(relPath).toString();
  } catch {
    // fallthrough: relative path として concat。 base / path の末尾 / 先頭の "/" を正規化
  }
  const baseTrimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const pathTrimmed = relPath.startsWith("/") ? relPath.slice(1) : relPath;
  return `${baseTrimmed}/${pathTrimmed}`;
}

/**
 * 1 kind handler から dispatcher / index に返す結果。
 *
 * - `scoreDelta`: deployment.score に加算する points (負値も可)。0 なら DDB write skip。
 * - `scoreEvents`: 別途 Deployments table の `EVENT#` 行として writeScoreEvent で書く marker 群。
 * - `endpointsHealthJson`: uptime 系で更新する health JSON (= participant aggregate 用)。
 *   省略時は更新しない。
 * - `postureJson` / `platform`: phased-polling 系が最後に観測した live posture snapshot。
 * - `newState`: 次 tick で read する scoring state (= bonusAwarded / attackCount)。
 * - `attackDetected`: legacy `attack-detected` source 用 marker (= uptime-flat で ok→fail
 *   遷移を検知したとき、source="attack-detected" / points=0 の event 行を別途書く)。
 */
export interface KindResult {
  readonly scoreDelta: number;
  readonly scoreEvents: readonly KindScoreEvent[];
  readonly endpointsHealthJson?: string;
  readonly postureJson?: string;
  readonly platform?: string;
  readonly newState?: DeploymentScoringState;
  readonly attackDetected?: boolean;
  readonly lastResult?: "ok" | "fail";
}

export interface KindScoreEvent {
  readonly source: "uptime" | "flag" | "attack-detected";
  readonly points: number;
  readonly occurredAt: string;
}

/**
 * `source: "uptime"` の score event を組む共通ヘルパ。 uptime-flat / uptime-multi / phased-polling
 * が同形の `{ source: "uptime", points, occurredAt }` を作るのを 1 箇所に集約する (= DRY)。
 */
export function uptimeEvent(points: number, occurredAt: string): KindScoreEvent {
  return { source: "uptime", points, occurredAt };
}

export function noopKindResult(): KindResult {
  return { scoreDelta: 0, scoreEvents: [] };
}

/**
 * `phased-polling` で参照する phase 定義 (= metadata.phases[] entries)。本 module は
 * dispatcher と phased-polling kind だけが触る (= scoring と phase は別 field なので
 * KindHandlerInput に乗せる)。
 */
export interface PhaseEntry {
  readonly name: string;
  readonly afterMinutes: number;
  readonly effect?: {
    readonly scorePathOverride?: string;
    readonly switchPlatformToDegraded?: readonly string[];
  };
}

/** kind handler の uniform input。dispatcher が組み立てる。 */
export interface KindHandlerInput<S extends ProblemScoringMetadata = ProblemScoringMetadata> {
  readonly deployment: Partial<DeploymentItem>;
  readonly scoring: S;
  /**
   * problem の metadata.endpoints[] (= slot 宣言)。空配列なら slot 経由解決は無効
   * (= legacy uptime-flat の outputKey フォールバックのみ動く)。
   */
  readonly slots: readonly ProblemEndpointSlot[];
  /**
   * 当該 (tenant, team, problem) の override 行 (Phase 3.A の Endpoint registry)。空配列なら
   * default URL のみで採点。
   */
  readonly overrides: readonly { readonly slot: string; readonly overrideUrl: string }[];
  /**
   * problem の metadata.phases[]。`phased-polling` kind だけが参照する (= 他 kind は空配列)。
   */
  readonly phases: readonly PhaseEntry[];
  readonly nowMs: number;
  readonly nowIso: string;
  readonly prevState: DeploymentScoringState;
}
