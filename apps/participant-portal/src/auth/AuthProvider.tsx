import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { getPortalMe, PortalAuthError } from "../api/portal-client";
import type { AppConfig } from "../config";
import { toAsciiSlug } from "../lib/slug";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

const DEFAULT_DEV_TTL_MS = 4 * 60 * 60 * 1000;

async function exchangeKeyForSession(
  config: AppConfig,
  teamLoginKey: string,
): Promise<ParticipantSession> {
  const trimmed = teamLoginKey.trim();
  if (trimmed.length === 0) {
    throw new Error("チームログインキーを入力してください");
  }

  if (config.mode === "backend") {
    // teamLoginKey 自体が bearer。backend が view を返したらそれを session 化する。
    // sessionToken には teamLoginKey そのものを保管 (sessionStorage は same-origin
    // 隔離されている前提) し、以降の polling でも同じキーを Authorization に乗せる。
    let view: Awaited<ReturnType<typeof getPortalMe>>;
    try {
      view = await getPortalMe(config.apiBaseUrl, trimmed);
    } catch (err) {
      if (err instanceof PortalAuthError) throw err;
      throw new Error(err instanceof Error ? err.message : "backend に接続できませんでした");
    }
    const now = Date.now();
    return {
      sessionToken: trimmed,
      teamId: view.jobId,
      teamName: view.teamName,
      eventId: view.problemId,
      issuedAt: now,
      // backend の expiresAt は epoch seconds、storage は ms に揃える。
      expiresAt: view.expiresAt > 0 ? view.expiresAt * 1000 : now + DEFAULT_DEV_TTL_MS,
    };
  }

  const slug = toAsciiSlug(trimmed);
  const now = Date.now();
  return {
    sessionToken: `mock.${slug}.${now.toString(36)}.session`,
    teamId: `team-${slug}`,
    teamName: `Team ${trimmed.slice(0, 8)}`,
    eventId: "mock-event-1",
    issuedAt: now,
    expiresAt: now + DEFAULT_DEV_TTL_MS,
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
