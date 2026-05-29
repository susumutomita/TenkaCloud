import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../../../helper-functions.js";
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
}

export function buildSharedResources(): GenericScoringSharedResources {
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    deploymentsTableName: getEnv("DEPLOYMENTS_TABLE_NAME"),
    eventsTableName: getEnv("EVENTS_TABLE_NAME"),
    endpointsTableName: getEnv("PROBLEM_ENDPOINTS_TABLE_NAME"),
    problemsScoring: parseScoringEnv(process.env.BATTLE_PROBLEMS_SCORING),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
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
export interface DeploymentScoringState {
  readonly bonusAwarded?: Readonly<Record<string, boolean>>;
  readonly attackCount?: number;
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
  return {
    ...(bonusAwarded ? { bonusAwarded } : {}),
    ...(attackCount !== undefined ? { attackCount } : {}),
  };
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
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
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
 * - `newState`: 次 tick で read する scoring state (= bonusAwarded / attackCount)。
 * - `attackDetected`: legacy `attack-detected` source 用 marker (= uptime-flat で ok→fail
 *   遷移を検知したとき、source="attack-detected" / points=0 の event 行を別途書く)。
 */
export interface KindResult {
  readonly scoreDelta: number;
  readonly scoreEvents: readonly KindScoreEvent[];
  readonly endpointsHealthJson?: string;
  readonly newState?: DeploymentScoringState;
  readonly attackDetected?: boolean;
  readonly lastResult?: "ok" | "fail";
}

export interface KindScoreEvent {
  readonly source: "uptime" | "flag" | "attack-detected";
  readonly points: number;
  readonly occurredAt: string;
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
