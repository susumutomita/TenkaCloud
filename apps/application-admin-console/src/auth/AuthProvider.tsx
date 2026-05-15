import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { AppConfig } from "../config";
import { beginLogin, beginLogout, loadStoredTokens, type TokenSet } from "./cognito";

interface AuthState {
  tokens: TokenSet | null;
  ready: boolean;
  login: () => void;
  logout: () => void;
  setTokens: (tokens: TokenSet) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const [tokens, setTokensState] = useState<TokenSet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTokensState(loadStoredTokens());
    setReady(true);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      tokens,
      ready,
      login: () => {
        void beginLogin(config);
      },
      logout: () => {
        // Issue #833: Cognito Hosted UI cookie + refresh token を server-side revoke
        // してから /logout に redirect する (= 旧コードは local sessionStorage のみ clear
        // で Cognito 側 cookie が残り silent re-login していた)。
        setTokensState(null);
        void beginLogout(config);
      },
      setTokens: (t) => setTokensState(t),
    }),
    [tokens, ready, config],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
