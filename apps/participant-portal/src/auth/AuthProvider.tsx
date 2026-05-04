import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { AppConfig } from "../config";
import { toAsciiSlug } from "../lib/slug";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

/**
 * Mock auth for `mode === "dev-mock"`. Real backend swaps in here behind the same I/F.
 */
async function exchangeKeyForSession(
  config: AppConfig,
  teamLoginKey: string,
): Promise<ParticipantSession> {
  const trimmed = teamLoginKey.trim();
  if (trimmed.length === 0) {
    throw new Error("チームログインキーを入力してください");
  }

  if (config.mode !== "dev-mock") {
    // TODO: backend 実装時にここで fetch(`${config.apiBaseUrl}/login`, ...) する
    throw new Error("backend が未実装のため、現状は dev モードでのみ login できます");
  }

  const slug = toAsciiSlug(trimmed);
  const now = Date.now();
  return {
    sessionToken: `mock.${slug}.${now.toString(36)}.session`,
    teamId: `team-${slug}`,
    teamName: `Team ${trimmed.slice(0, 8)}`,
    eventId: "mock-event-1",
    issuedAt: now,
    expiresAt: now + 4 * 60 * 60 * 1000,
  };
}

interface AuthState {
  session: ParticipantSession | null;
  ready: boolean;
  /** team login key を渡してセッションを発行。失敗時は throw する。 */
  login: (teamLoginKey: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const [session, setSession] = useState<ParticipantSession | null>(() => loadSession());

  const login = useCallback(
    async (teamLoginKey: string) => {
      const next = await exchangeKeyForSession(config, teamLoginKey);
      saveSession(next);
      setSession(next);
    },
    [config],
  );

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, ready: true, login, logout }),
    [session, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
