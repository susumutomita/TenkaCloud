import type { Platform, ProbeResult } from "./scoring.js";

/**
 * Microservice Migration Battle (Phase 2) polling Lambda の outbound HTTP probe。
 *
 * **`fetch` 直接呼び出しの exception**:
 *   harness の `handler-must-not-call-fetch` rule は `lib/handlers/` 内での tenant API
 *   handler が外部依存を埋めるのを防ぐためのもの。本 Lambda は EventBridge から
 *   1 min tick で起動する outbound probe で、対象は競技者が登録した URL であり、
 *   tenant 認可フローには関与しない。同じ理由で `health-check-handler` も `fetch` を
 *   呼ぶことが許されている (= EventBridge tick 経路の outbound probe)。
 *
 * 本ファイルを probe.ts として handler ディレクトリ直下に置き、scoring (pure) と
 * 分けることで、テスト時の `vi.mock("./probe")` で fetch 自体をスタブできるよう
 * にしている。
 */

const META_TIMEOUT_MS = 4_000;
const SCORE_TIMEOUT_MS = 8_000;

const KNOWN_PLATFORMS = new Set<Platform>(["ec2", "lambda", "ecs", "apprunner"]);

function joinUrl(base: string, relPath: string): string {
  if (!relPath) return base;
  try {
    return new URL(relPath).toString();
  } catch {
    return new URL(relPath, base.endsWith("/") ? base : `${base}/`).toString();
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET <url>/meta` を叩いて platform を取り出す (= 競技者の自己申告)。
 * 値が KNOWN_PLATFORMS に無いなら `unknown` に倒す (= 不正値 / typo を安全側に倒す)。
 * 失敗 (timeout / non-2xx / parse 失敗) なら undefined を返す。
 */
export async function fetchPlatform(baseUrl: string): Promise<Platform | undefined> {
  try {
    const res = await fetchWithTimeout(joinUrl(baseUrl, "/meta"), META_TIMEOUT_MS);
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") return undefined;
    const raw = (body as { platform?: unknown }).platform;
    if (typeof raw !== "string") return undefined;
    return KNOWN_PLATFORMS.has(raw as Platform) ? (raw as Platform) : "unknown";
  } catch {
    return undefined;
  }
}

/**
 * `GET <url>/score(?legacy=true)` を叩いて status + 応答時間を観測する。
 *
 * - timeout: status=0 / reason=timeout
 * - network error: status=0 / reason=network
 * - non-2xx: ok=false / reason=non-2xx
 * - 2xx: ok=true
 *
 * platform は別 RPC (`fetchPlatform`) の結果を呼び出し側で merge する想定。
 */
export async function probeScore(
  baseUrl: string,
  scorePath: "/score" | "/score?legacy=true",
): Promise<{
  ok: boolean;
  status: number;
  responseTimeMs: number;
  reason?: ProbeResult["reason"];
}> {
  const url = joinUrl(baseUrl, scorePath);
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(url, SCORE_TIMEOUT_MS);
    const elapsed = Date.now() - startedAt;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, responseTimeMs: elapsed };
    }
    return { ok: false, status: res.status, responseTimeMs: elapsed, reason: "non-2xx" };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const name = (err as { name?: string })?.name ?? "";
    if (name === "AbortError") {
      return { ok: false, status: 0, responseTimeMs: elapsed, reason: "timeout" };
    }
    return { ok: false, status: 0, responseTimeMs: elapsed, reason: "network" };
  }
}

export { joinUrl };
