import type { MiddlewareHandler } from "hono";

/**
 * Issue #1694: execute-api (Hono on Lambda) の JSON レスポンスにセキュリティヘッダを付与する
 * 共有 middleware。 SPA 静的配信 (CloudFront ResponseHeadersPolicy, #855) と違い API は別
 * オリジンでヘッダが付いていなかったため、 CloudFront を経由しない直叩きに対する多層防御として
 * API レスポンスにも同等のヘッダを付ける (元監査 4 / 8 / 1 / 5 / 7)。
 *
 * **なぜ Hono 標準の `hono/secure-headers` を直接使わないか**:
 *   標準 `secureHeaders()` は default で `Cross-Origin-Resource-Policy: same-origin` /
 *   `Cross-Origin-Embedder-Policy: require-corp` / `Cross-Origin-Opener-Policy: same-origin`
 *   を付ける。 本 API は SPA (CloudFront origin) から **クロスオリジン** で fetch される
 *   (= API は `*.execute-api` origin)。 CORP: same-origin はクロスオリジン読み取りを壊し得る
 *   ため、 これらを 1 つ 1 つ false にするより、 安全なヘッダだけを明示的に立てる方が
 *   「CORS を壊さない」 (受け入れ条件) を確実に満たせる。
 *
 * 付与するヘッダ:
 *   - `X-Content-Type-Options: nosniff` — MIME sniffing 由来の JSON-XSS を無効化 (監査 4)。常に強制。
 *   - `X-Frame-Options: DENY` — API レスポンスは frame 化させない (監査 1)。常に強制。
 *   - `Referrer-Policy: strict-origin-when-cross-origin` — リファラ漏洩を抑制 (監査 7)。常に強制。
 *   - `Cache-Control: no-store` — 認証必須 / 機密 JSON をキャッシュさせない (監査 8)。
 *       route が独自に Cache-Control を立てた場合は尊重 (= 上書きしない) ので、 将来 cacheable な
 *       public endpoint が出ても opt-out できる。
 *   - `Content-Disposition: attachment` — JSON を直叩きされたときの inline render を防ぐ多層防御
 *       (監査 4)。 fetch/XHR では無視されるため SPA は壊れない。 **JSON のみ** に付け、 CSV export 等が
 *       既に独自 Content-Disposition (`attachment; filename=...`) を立てている場合は尊重する。
 *
 * `await next()` 後に `c.res.headers` を直接 set する (= Hono 標準 secureHeaders と同じ機構)。
 * これにより onError 経由のエラーレスポンスにもヘッダが付く。
 */
export function secureApiHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
    const contentType = headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json") && !headers.has("Content-Disposition")) {
      headers.set("Content-Disposition", "attachment");
    }
  };
}
