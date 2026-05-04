import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { AppConfig } from "../config";
import { beginLogin, clearTokens, loadStoredTokens, type TokenSet } from "./cognito";

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
        clearTokens();
        setTokensState(null);
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
