import {
  type BeginLoginOptions,
  beginLogin,
  beginLogout,
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
import type { AppConfig } from "../config";

interface AuthState {
  tokens: TokenSet | null;
  ready: boolean;
  /**
   * Cognito Hosted UI へ redirect する。 Issue #1329: LoginPage が signing-in /
   * error UI 状態を出せるよう Promise を返す (= 旧 fire-and-forget の `void` 戻り値だと
   * PKCE 派生 / redirect URL 構築の失敗を UI に出せなかった)。
   * Issue #1340 Phase 2: `identityProvider` 未指定なら local Cognito sign-in、 指定すると
   * `identity_provider=` を付けて SAML IdP に直接飛ばす (= SP-initiated HRD bypass)。
   */
  login: (options?: BeginLoginOptions) => Promise<void>;
  logout: () => void;
  setTokens: (tokens: TokenSet) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Issue #859: idle session 自動ログアウト (= admin-console と同 design)。 15 分の
 * mouse / keyboard / touch / focus 無操作で Cognito refresh token を revoke して logout。
 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const IDLE_EVENTS = ["mousedown", "keydown", "touchstart", "focus", "scroll"] as const;

export function AuthProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const [tokens, setTokensState] = useState<TokenSet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // ADR-025: tokens は memory (React state) のみで保持し sessionStorage には残さない
    // (XSS によるトークン持ち出し面を断つ)。 旧バージョンが永続化した token を purge する。
    // reload で memory が消えると RequireAuth → Login が Cognito Hosted UI へ auto-redirect し、
    // 既存 session cookie 経由で silent re-auth に倒れる (= 完全シームレスではなく往復は挟む)。
    purgeLegacyTokenStorage();
    setReady(true);
  }, []);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logout = useCallback(() => {
    // Issue #833: Cognito Hosted UI cookie + refresh token を server-side revoke
    // してから /logout に redirect する (= 旧コードは local sessionStorage のみ clear
    // で Cognito 側 cookie が残り silent re-login していた)。
    // ADR-025: token は memory 保持なので、 revoke 対象の現在値を beginLogout に渡す。
    setTokensState(null);
    void beginLogout(config, tokens);
  }, [config, tokens]);

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
