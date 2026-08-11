/**
 * Issue #1418 web-kit Stage 3: admin-console / application-admin-console に copy-paste されていた
 * Cognito AuthProvider を共有化する。 両 SPA はコメント (Issue 参照) 以外コード byte 一致だった。
 *
 * 設計の要点:
 *   - **token は memory (React state) のみで保持**し sessionStorage には残さない
 *     (XSS によるトークン持ち出し面を断つ)。 reload で memory が消えると RequireAuth → Login が
 *     Cognito Hosted UI へ auto-redirect し、 既存 session cookie 経由で silent re-auth に倒れる。
 *   - **Issue #859: idle session 自動ログアウト**。 15 分間 mouse / keyboard / touch / focus /
 *     scroll 操作が無ければ Cognito refresh token を revoke して logout し、 stolen JWT の利用窓を
 *     idToken 寿命 (= 1h) ではなく 15 min に短縮する defense-in-depth。
 *   - **Issue #833: logout は server-side revoke 経由**。 Cognito Hosted UI cookie + refresh token を
 *     revoke してから /logout に redirect する (= local clear だけだと silent re-login していた)。
 *
 * config は render 時の prop として渡る (= 各 SPA の `AppConfig` は `CognitoOAuthConfig` の superset)
 * ので factory 化は不要。 両 SPA は `export { AuthProvider, useAuth } from "@tenkacloud/web-kit"` で
 * 載せ替える。
 */

import {
  type BeginLoginOptions,
  beginLogin,
  beginLogout,
  type CognitoOAuthConfig,
  purgeLegacyTokenStorage,
  type TokenSet,
} from "@tenkacloud/auth-client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface AuthState {
  tokens: TokenSet | null;
  ready: boolean;
  /**
   * Cognito Hosted UI へ redirect する。 LoginPage が signing-in / error UI 状態を出せるよう
   * Promise を返す。 `identityProvider` 未指定なら local Cognito sign-in、 指定すると
   * `identity_provider=` を付けて SAML IdP に直接飛ばす (= SP-initiated HRD bypass)。
   */
  login: (options?: BeginLoginOptions) => Promise<void>;
  logout: () => void;
  setTokens: (tokens: TokenSet) => void;
}

const AuthContext = createContext<AuthState | null>(null);

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const IDLE_EVENTS = ["mousedown", "keydown", "touchstart", "focus", "scroll"] as const;

export function AuthProvider({
  config,
  children,
}: {
  config: CognitoOAuthConfig;
  children: ReactNode;
}) {
  const [tokens, setTokensState] = useState<TokenSet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 旧バージョンが永続化した token を purge してから ready にする。
    purgeLegacyTokenStorage();
    setReady(true);
  }, []);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logout = useCallback(() => {
    // token は memory 保持なので、revoke 対象の現在値を beginLogout に渡す。
    setTokensState(null);
    void beginLogout(config, tokens);
  }, [config, tokens]);

  // Issue #859: idle timeout を tokens が存在するときのみ起動。
  useEffect(() => {
    if (!tokens) return;
    const resetTimer = (): void => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        logout();
      }, IDLE_TIMEOUT_MS);
    };
    resetTimer();
    for (const evt of IDLE_EVENTS) {
      window.addEventListener(evt, resetTimer, { passive: true });
    }
    return () => {
      // cleanup 時は直前の resetTimer() で必ず timer が set 済 (この effect は tokens truthy
      // のときだけ cleanup を登録し、 その run は必ず resetTimer() を呼ぶ)。 null 経路は不到達。
      /* v8 ignore next */
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      for (const evt of IDLE_EVENTS) {
        window.removeEventListener(evt, resetTimer);
      }
    };
  }, [tokens, logout]);

  const value = useMemo<AuthState>(
    () => ({
      tokens,
      ready,
      login: (options) => beginLogin(config, options),
      logout,
      setTokens: (t) => setTokensState(t),
    }),
    [tokens, ready, config, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
