import { isExpired, loadTokens, type StoredTokens, saveTokens } from "../credential-store.ts";

/**
 * Issue #1305: refresh_token grant で access_token を自動更新する。
 *
 * 戦略:
 *   - token が `thresholdSec` (default 300s = 5min) 以内に expire するなら refresh を試みる
 *   - refresh 成功 → store 更新 + 新 tokens を返す
 *   - refresh 失敗 (refresh_token も死亡 / network error) → `RefreshError` を throw して
 *     呼び出し側で 401 path にフォールバックさせる
 *
 * Hosted UI domain は store された tokens には記録されない (= login 時の env で決まる)
 * ため、 caller が env から渡す (= `TENKACLOUD_COGNITO_HOSTED_UI_DOMAIN`)。
 *
 * **絶対に access_token / refresh_token を log に出さない** (= debug log でも mask)。
 */

export class RefreshError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

export interface RefreshConfig {
  readonly hostedUiDomain: string;
  /** default 300 (= 5min) */
  readonly thresholdSec?: number;
  /** test 用 fetch 差し替え hook */
  readonly fetchImpl?: typeof fetch;
  /** test 用 now (= unix seconds) */
  readonly nowSec?: () => number;
}

export function needsRefresh(
  tokens: StoredTokens,
  thresholdSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return tokens.expiresAt - nowSec <= thresholdSec;
}

export async function refreshTokens(
  tokens: StoredTokens,
  config: RefreshConfig,
): Promise<StoredTokens> {
  if (!tokens.refreshToken) {
    throw new RefreshError("refresh_token がありません。 再 login が必要です");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.hostedUiDomain.replace(/\/$/, "")}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: tokens.clientId,
    refresh_token: tokens.refreshToken,
  });
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new RefreshError("refresh request が失敗しました (network error)", err);
  }
  if (!res.ok) {
    // 401 / 400 で来るのは refresh_token revoke / expire。 loud に fail。
    throw new RefreshError(`refresh failed: HTTP ${res.status} (再 login してください)`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.id_token || typeof json.expires_in !== "number") {
    throw new RefreshError(
      "refresh response が不正です (access_token / id_token / expires_in 欠落)",
    );
  }
  const now = config.nowSec ? config.nowSec() : Math.floor(Date.now() / 1000);
  return {
    accessToken: json.access_token,
    idToken: json.id_token,
    // Cognito は通常 refresh_token を rotate しない (= 同じ rt を返さない)。 残値があれば差し替え。
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    expiresAt: now + json.expires_in,
    issuer: tokens.issuer,
    clientId: tokens.clientId,
  };
}

/**
 * stored tokens を必要に応じて refresh して返す。 戻り値は **常に valid な tokens**。
 *
 * - tokens 不在 → undefined を返す (= caller は 401 path に分岐)
 * - 既に expire 済 → refresh を実行 (失敗時 throw)
 * - threshold 以内 → refresh を実行 (失敗時 throw)
 * - 余裕あり → そのまま返す
 *
 * refresh 成功時は credential-store に書き戻す (= 次回 CLI invocation を save)。
 */
export async function getValidTokens(config: RefreshConfig): Promise<StoredTokens | undefined> {
  const stored = loadTokens();
  if (!stored) return undefined;
  const nowFn = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const now = nowFn();
  const threshold = config.thresholdSec ?? 300;
  if (!isExpired(stored, now) && !needsRefresh(stored, threshold, now)) {
    return stored;
  }
  const refreshed = await refreshTokens(stored, config);
  saveTokens(refreshed);
  return refreshed;
}
