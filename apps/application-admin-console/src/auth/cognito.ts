import type { AppConfig } from "../config";
import { deriveChallenge, generateVerifier } from "./pkce";

/**
 * apps/admin-console/src/auth/cognito.ts と同実装 (AppConfig は本 app では
 * apiBaseUrl を持たないが、本ファイルは apiBaseUrl を参照しないので影響なし)。
 * 将来 packages/auth-shared に切り出すかは別 Issue。
 */

const VERIFIER_KEY = "TenkaCloud.pkce_verifier";
const STATE_KEY = "TenkaCloud.oauth_state";
const TOKENS_KEY = "TenkaCloud.tokens";

export interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function beginLogin(config: AppConfig): Promise<void> {
  const verifier = generateVerifier();
  const challenge = await deriveChallenge(verifier);
  const state = generateVerifier(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
  url.searchParams.set("client_id", config.cognitoClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);

  window.location.assign(url.toString());
}

export async function completeLogin(
  config: AppConfig,
  code: string,
  returnedState?: string,
): Promise<TokenSet> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("PKCE verifier missing (session lost before callback)");

  // Issue #861: state check を fail-closed に。 不在 (= session 切れ / sessionStorage clear)
  // を CSRF / phishing 経路の signal として throw する。
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("OAuth state mismatch or missing (possible CSRF attempt or session lost)");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.cognitoClientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Cognito token exchange failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  const tokens: TokenSet = {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

export function loadStoredTokens(): TokenSet | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as TokenSet;
    if (tokens.expiresAt <= Date.now()) {
      sessionStorage.removeItem(TOKENS_KEY);
      return null;
    }
    return tokens;
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

/**
 * Issue #833: Cognito Hosted UI session (= cookie) を revoke してから redirect する。
 *
 * 旧 logout は `clearTokens()` (= sessionStorage) のみで、 Cognito 側の session cookie
 * は browser に残ったまま。 次に `beginLogin` で /oauth2/authorize に redirect すると、
 * Cognito が既存 cookie で silent re-login させ、 Hosted UI を経由せずに画面に戻って
 * しまっていた。
 *
 * 修正:
 *   1. refresh token があれば `/oauth2/revoke` で server-side revoke
 *   2. sessionStorage を clearTokens
 *   3. `/logout?client_id=...&logout_uri=...` に redirect し Cognito cookie を破棄
 *
 * `logout_uri` は UserPoolClient の sign-out URLs に登録されている origin に
 * redirect する (= 多くの環境で `<redirectUri origin>/login` を登録済)。
 */
export async function beginLogout(config: AppConfig): Promise<void> {
  // (1) refresh token の server-side revoke (= best-effort、 失敗しても続行)
  const stored = loadStoredTokens();
  if (stored?.refreshToken) {
    try {
      await fetch(`${config.cognitoDomain}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: stored.refreshToken,
          client_id: config.cognitoClientId,
        }),
      });
    } catch {
      // revoke endpoint 失敗は production session 残留にしかつながらない (= 致命的でない)
      // ので silently 続ける。 logout redirect で Cognito cookie は消える。
    }
  }
  // (2) local 側 token を確実に破棄
  clearTokens();
  // (3) Hosted UI cookie を破棄するため `/logout` に redirect。 logout_uri は
  //     UserPoolClient の `Allowed sign-out URLs` に含まれている origin に揃える。
  const logoutUrl = new URL(`${config.cognitoDomain}/logout`);
  logoutUrl.searchParams.set("client_id", config.cognitoClientId);
  // redirectUri の origin + "/login" を logout 後の戻り先にする (= 既存 PKCE callback
  // と同 origin、 UserPoolClient の sign-out URL 設定と整合)。
  const callbackOrigin = new URL(config.redirectUri).origin;
  logoutUrl.searchParams.set("logout_uri", `${callbackOrigin}/login`);
  window.location.assign(logoutUrl.toString());
}
