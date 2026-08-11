/**
 * Cognito Hosted UI OAuth 2.0 Code Flow + PKCE shared client.
 *
 * Issue #1246: extracted from per-app duplicates in `apps/admin-console/src/auth/cognito.ts`
 * and `apps/application-admin-console/src/auth/cognito.ts`. The flow is identical between the
 * two SPAs (begin login -> Cognito callback -> exchange code for tokens -> return them to the
 * caller -> begin logout revokes refresh token and clears Hosted UI cookie).
 *
 * Tokens (id/access/refresh) are NEVER persisted to web storage. completeLogin
 * returns the TokenSet and the caller (AuthProvider) keeps it in memory (React state) only,
 * so an XSS payload has no sessionStorage / localStorage bearer token to read out. The only
 * sessionStorage left is the short-lived PKCE verifier + OAuth state, which must survive the
 * full-page redirect to Cognito and back. A reload drops the in-memory token and re-auths
 * silently against the Cognito Hosted UI session cookie.
 *
 * Behavior preserved verbatim including:
 *   - Issue #861: fail-closed OAuth state validation (missing state in sessionStorage is treated
 *     as CSRF / session loss).
 *   - Issue #833: `/oauth2/revoke` (best-effort) + clear sessionStorage + `/logout` redirect.
 *     The logout URL carries `client_id` + `logout_uri` + `redirect_uri` + `response_type=code`
 *     so it works under both legacy and OIDC-conformant UserPool modes (Cognito legacy logout
 *     endpoint ignores extra params).
 */

import { deriveChallenge, generateVerifier } from "./pkce";

const VERIFIER_KEY = "TenkaCloud.pkce_verifier";
const STATE_KEY = "TenkaCloud.oauth_state";
// A previous app version persisted the bearer TokenSet under this key. Tokens are
// now memory-only; the key is retained solely so `purgeLegacyTokenStorage` can evict a stale
// token left behind in a tab that was already open before the upgrade.
const LEGACY_TOKENS_KEY = "TenkaCloud.tokens";

/**
 * Minimal config surface the OAuth client needs. The hosting SPA `AppConfig` is a superset
 * (it also carries `apiBaseUrl`, tenant metadata, etc) and matches structurally so callers
 * pass their full `AppConfig` directly.
 */
export interface CognitoOAuthConfig {
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly redirectUri: string;
  readonly scope: string;
}

export interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface BeginLoginOptions {
  /**
   * Issue #1335 Phase 1: SP-initiated SAML SSO で Cognito Hosted UI の Home Realm Discovery を
   * bypass し、 指定 IdP に直接飛ばす。 `idp-resolution.resolveIdp` が `kind: "redirect"` /
   * `"select"` の場合だけ渡る (= local Cognito sign-in は未指定で従来動作)。
   */
  readonly identityProvider?: string;
}

export async function beginLogin(
  config: CognitoOAuthConfig,
  options: BeginLoginOptions = {},
): Promise<void> {
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
  if (options.identityProvider) {
    // Cognito 公式仕様 (= AWS doc: Using the Authorize endpoint): `identity_provider=<providerName>`
    // で IdP 直指定。 managed login の domain-based HRD を bypass する。 multi-IdP per email
    // domain 対応 (Issue #1335) の鍵。
    url.searchParams.set("identity_provider", options.identityProvider);
  }

  window.location.assign(url.toString());
}

export async function completeLogin(
  config: CognitoOAuthConfig,
  code: string,
  returnedState?: string,
): Promise<TokenSet> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("PKCE verifier missing (session lost before callback)");

  // Issue #861: state check は **fail-closed**。 旧コードは expectedState が null のとき check
  // を skip していたため、 attacker が victim の sessionStorage を clear してから callback URL を
  // 送り付けると state validation を bypass できた。 sessionStorage に state が無い時点で
  // beginLogin() を再走行しないと到達不能経路なので、 不在は CSRF / session 切れの signal。
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
  // Do NOT persist tokens. Return them to the caller for in-memory (React state) storage.
  return tokens;
}

/**
 * Evict any bearer TokenSet a previous app version persisted to sessionStorage.
 * Tokens are now memory-only, so a leftover token in an already-open tab would needlessly
 * stay readable by JavaScript. Call once on app init. The PKCE verifier + OAuth state are
 * deliberately left intact so a /callback load mid-flow can still complete the exchange.
 * Idempotent and tolerant of storage being unavailable (private mode).
 */
export function purgeLegacyTokenStorage(): void {
  try {
    sessionStorage.removeItem(LEGACY_TOKENS_KEY);
  } catch {
    // sessionStorage unavailable (private mode / disabled) — nothing to purge.
  }
}

/**
 * Clear the in-flight PKCE verifier + OAuth state (and defensively the legacy token key).
 * Used on logout and to abort a half-started login. completeLogin already clears the PKCE
 * artifacts on its own success path.
 */
export function clearStoredAuthState(): void {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(LEGACY_TOKENS_KEY);
}

/**
 * Issue #833: Cognito Hosted UI session (= cookie) を revoke してから redirect する。
 *
 * 旧 logout は local sessionStorage の clear のみで、 Cognito 側の session cookie は
 * browser に残ったまま。 次に `beginLogin` で /oauth2/authorize に redirect すると、
 * Cognito が既存 cookie で silent re-login させ、 Hosted UI を経由せずに画面に戻って
 * しまっていた。
 *
 * 修正:
 *   1. refresh token があれば `/oauth2/revoke` で server-side revoke (token は
 *      memory 保持なので呼び出し元が現在の TokenSet を渡す)
 *   2. sessionStorage の PKCE state を `clearStoredAuthState`
 *   3. `/logout?client_id=...&logout_uri=...&redirect_uri=...&response_type=code`
 *      に redirect し Cognito cookie を破棄
 *
 * `logout_uri` (= legacy) と `redirect_uri` (= OIDC-conformant) の **両方を付ける**。
 * OIDC-conformant mode の UserPool では `redirect_uri` が必須で、 legacy mode は余分な param を
 * ignore するため、 両方付けることでどちらの環境でも動く (= AWS Cognito 仕様)。
 */
export async function beginLogout(
  config: CognitoOAuthConfig,
  tokens?: TokenSet | null,
): Promise<void> {
  // (1) refresh token の server-side revoke (= best-effort、 失敗しても続行)
  if (tokens?.refreshToken) {
    try {
      await fetch(`${config.cognitoDomain}/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refreshToken,
          client_id: config.cognitoClientId,
        }),
      });
    } catch {
      // revoke endpoint 失敗は production session 残留にしかつながらない (= 致命的でない)
      // ので silently 続ける。 logout redirect で Cognito cookie は消える。
    }
  }
  // (2) PKCE transient + 旧永続 token を確実に破棄
  clearStoredAuthState();
  // (3) Hosted UI cookie を破棄するため `/logout` に redirect。 sign-out URL は
  //     UserPoolClient の `Allowed sign-out URLs` に含まれている origin に揃える
  //     (= 多くの環境で `<redirectUri origin>/login` を登録済)。
  const logoutUrl = new URL(`${config.cognitoDomain}/logout`);
  logoutUrl.searchParams.set("client_id", config.cognitoClientId);
  const callbackOrigin = new URL(config.redirectUri).origin;
  const postLogoutUri = `${callbackOrigin}/login`;
  logoutUrl.searchParams.set("logout_uri", postLogoutUri);
  logoutUrl.searchParams.set("redirect_uri", postLogoutUri);
  logoutUrl.searchParams.set("response_type", "code");
  window.location.assign(logoutUrl.toString());
}
