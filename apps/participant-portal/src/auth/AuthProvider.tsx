import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { AppConfig } from "../config";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

/**
 * チームログインキーを backend に渡してセッションを取る。
 *
 * 現状は backend (Lambda Function URL) が未実装なので mock validator を使う:
 *   - 任意の non-empty key を受け入れる
 *   - チーム名は key 先頭から切り出した先頭 8 文字 + ランダムサフィックス
 *   - 期限は 4 時間
 *
 * 本物の backend が来たら fetch(`${config.apiBaseUrl}/login`, { teamLoginKey }) に差し替える。
 */
async function exchangeKeyForSession(
  config: AppConfig,
  teamLoginKey: string,
): Promise<ParticipantSession> {
  if (teamLoginKey.trim().length === 0) {
    throw new Error("チームログインキーを入力してください");
  }
  const _ = config; // backend 連携時に使用 (lint 抑止)

  // --- mock validator (TODO: 本物 backend に差し替え) ---
  const fakeTeamId = `team-${
    teamLoginKey
      .slice(0, 6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "x") || "anon"
  }`;
  const fakeTeamName = `Team ${teamLoginKey.slice(0, 8) || "Anonymous"}`;
  const now = Date.now();
  return {
    sessionToken: `mock.${btoa(teamLoginKey).slice(0, 24)}.session`,
    teamId: fakeTeamId,
    teamName: fakeTeamName,
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
