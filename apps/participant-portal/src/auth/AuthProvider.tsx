import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { AppConfig } from "../config";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

/**
 * チームログインキーを backend に渡してセッションを取る。
 *
 * 現状は backend (Lambda Function URL) が未実装なので mock validator を使う:
 *   - 任意の non-empty key を受け入れる
 *   - チーム名は key 先頭から切り出した英数字 slug
 *   - 期限は 4 時間
 *
 * 本物の backend が来たら fetch(`${config.apiBaseUrl}/login`, { teamLoginKey }) に差し替える。
 *
 * `config` は backend 連携で使うので参照する (現状は dev fallback URL を確認するだけ)。
 */
async function exchangeKeyForSession(
  config: AppConfig,
  teamLoginKey: string,
): Promise<ParticipantSession> {
  const trimmed = teamLoginKey.trim();
  if (trimmed.length === 0) {
    throw new Error("チームログインキーを入力してください");
  }

  // dev mode: backend がまだ無いので、現在の apiBaseUrl が dev fallback の場合は mock を返す。
  // 本物 backend に差し替えた後はここで fetch(`${config.apiBaseUrl}/login`, ...) する。
  const isDev = config.apiBaseUrl.includes("dev-mock") || config.apiBaseUrl.includes("localhost");
  if (!isDev) {
    // 本物 backend が立ったらこの分岐に実装を入れる
    throw new Error("backend が未実装のため、現状は dev モードでのみ login できます");
  }

  // --- mock validator (TODO: 本物 backend に差し替え) ---
  // teamLoginKey は japanese / unicode を含み得るので、ASCII slug に変換してから ID 化する
  // (btoa は latin1 のみ対応で日本語が来ると DOMException を投げるため使わない)。
  const slugSource =
    trimmed
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase()
      .slice(0, 12) || "anon";
  const fakeTeamId = `team-${slugSource}`;
  const fakeTeamName = `Team ${trimmed.slice(0, 8)}`;
  const now = Date.now();
  return {
    sessionToken: `mock.${slugSource}.${now.toString(36)}.session`,
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
