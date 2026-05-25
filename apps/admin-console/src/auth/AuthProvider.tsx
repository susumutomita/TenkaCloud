import {
  type BeginLoginOptions,
  beginLogin,
  beginLogout,
  loadStoredTokens,
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
import type { AppConfig } from "../config";

interface AuthState {
  tokens: TokenSet | null;
  ready: boolean;
  /**
   * Cognito Hosted UI へ redirect する。 Issue #1329: LoginPage が signing-in /
   * error UI 状態を出せるよう Promise を返す。
   * Issue #1335 Phase 1: `identityProvider` 未指定なら local Cognito sign-in、 指定すると
   * `identity_provider=` を付けて SAML IdP に直接飛ばす (= SP-initiated HRD bypass)。
   */
  login: (options?: BeginLoginOptions) => Promise<void>;
  logout: () => void;
  setTokens: (tokens: TokenSet) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Issue #859: idle session 自動ログアウト。 15 分間 mouse / keyboard / touch / focus
 * 操作が無ければ Cognito 側 refresh token を revoke して logout する。 stolen JWT の
 * 利用窓を Cognito idToken 寿命 (= 1h) ではなく 15 min に短縮する defense-in-depth。
 *
 * timer は user 操作毎に reset。 `idle` event は throttle 不要 (= setTimeout の 1 度 fire)。
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const IDLE_EVENTS = ["mousedown", "keydown", "touchstart", "focus", "scroll"] as const;

export function AuthProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const [tokens, setTokensState] = useState<TokenSet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTokensState(loadStoredTokens());
    setReady(true);
  }, []);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logout = useCallback(() => {
    // Issue #833: Cognito Hosted UI cookie + refresh token を server-side revoke
    // してから /logout に redirect する (= 旧コードは local sessionStorage のみ clear
    // で Cognito 側 cookie が残り silent re-login していた)。
    setTokensState(null);
    void beginLogout(config);
  }, [config]);

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
