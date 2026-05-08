import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { getPortalMe, PortalAuthError } from "../api/portal-client";
import type { AppConfig } from "../config";
import { toAsciiSlug } from "../lib/slug";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

const DEFAULT_DEV_TTL_MS = 4 * 60 * 60 * 1000;
// Phase 1 以前 (jobId-based) の deployment は eventId / teamId を持たない。
// session には何かしら値を入れる必要がある (UI が表示するため) ので、
// "(unknown)" placeholder を使う。Phase 4 で旧 deployment 行が消えれば削除可能。
const UNKNOWN_PLACEHOLDER = "(unknown)";

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
    // sessionToken には teamLoginKey そのものを保管 (localStorage は same-origin
    // 隔離されている前提) し、以降の polling でも同じキーを Authorization に乗せる。
    let view: Awaited<ReturnType<typeof getPortalMe>>;
    try {
      view = await getPortalMe(config.apiBaseUrl, trimmed);
    } catch (err) {
      if (err instanceof PortalAuthError) throw err;
      throw new Error(err instanceof Error ? err.message : "backend に接続できませんでした");
    }
    const now = Date.now();
    // Phase 2c: teamLoginKey で引いた view は team scope。teamId / eventId は team から、
    // expiresAt は最初の problem から取る (= team の全 problems で同じ TTL を持つ前提)。
    const firstProblem = view.problems[0];
    const expiresAtMs =
      firstProblem && firstProblem.expiresAt > 0
        ? firstProblem.expiresAt * 1000
        : now + DEFAULT_DEV_TTL_MS;
    return {
      sessionToken: trimmed,
      teamId: view.team.teamId ?? UNKNOWN_PLACEHOLDER,
      teamName: view.team.teamName,
      eventId: view.team.eventId ?? UNKNOWN_PLACEHOLDER,
      issuedAt: now,
      expiresAt: expiresAtMs,
      teamNameSetByCompetitor: view.team.teamNameSetByCompetitor,
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
    // dev-mock では teamName は競技者選択に追従しないので「設定済み」扱いにして setup を skip。
    teamNameSetByCompetitor: true,
  };
}

interface AuthState {
  session: ParticipantSession | null;
  ready: boolean;
  /** team login key を渡してセッションを発行。失敗時は throw する。 */
  login: (teamLoginKey: string) => Promise<void>;
  logout: () => void;
  /**
   * セッションの一部フィールド (teamName / teamNameSetByCompetitor) を更新する。
   * `PATCH /portal/me` の結果を AuthProvider 経由で反映するための内部 API。
   */
  updateSession: (
    patch: Pick<Partial<ParticipantSession>, "teamName" | "teamNameSetByCompetitor">,
  ) => void;
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

  const updateSession = useCallback<AuthState["updateSession"]>((patch) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next: ParticipantSession = {
        ...prev,
        ...(patch.teamName !== undefined ? { teamName: patch.teamName } : {}),
        ...(patch.teamNameSetByCompetitor !== undefined
          ? { teamNameSetByCompetitor: patch.teamNameSetByCompetitor }
          : {}),
      };
      saveSession(next);
      return next;
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, ready: true, login, logout, updateSession }),
    [session, login, logout, updateSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
