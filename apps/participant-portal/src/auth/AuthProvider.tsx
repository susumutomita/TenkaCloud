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
import { getPortalMe, PortalAuthError } from "../api/portal-client";
import type { AppConfig } from "../config";
import { toAsciiSlug } from "../lib/slug";
import { clearSession, loadSession, type ParticipantSession, saveSession } from "./storage";

/**
 * Issue #859: participant portal の idle session 自動ログアウト。
 *
 * **6 hours** で auto logout する。 admin console の 15 min より長い理由:
 *   - 競技中 (= 90 min ~ 4 h) は participant が席を離れる時間も含めて session 維持が必要
 *   - admin operator は監視業務で 15 min 周期で操作するが、 participant は問題に集中する
 *     ため操作頻度が低い (= 解析 / 思考時間で 30 min 以上 idle になる)
 *   - 競技時間上限 (= TenkaCloud Battle 仕様で最大 6 h 想定) 後に自動 logout で安全弁
 */
const PARTICIPANT_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const IDLE_EVENTS = ["mousedown", "keydown", "touchstart", "focus", "scroll"] as const;

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
    throw new Error("EMPTY_TEAM_LOGIN_KEY");
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
      // getPortalMe は network / parse 失敗時も Error を throw するため、 非 Error fallback は到達不能。
      /* v8 ignore next */
      const message = err instanceof Error ? err.message : "BACKEND_UNREACHABLE";
      throw new Error(message);
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
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const login = useCallback(
    async (teamLoginKey: string) => {
      const next = await exchangeKeyForSession(config, teamLoginKey);
      saveSession(next);
      setSession(next);
    },
    [config],
  );

  // LP iframe からの demo 起動: `?demo=1` を query に乗せて開くと、 dev-mock モード
  // のときだけ固定 team で auto-login して dashboard を即表示する。 production
  // (`mode === "backend"`) では何もしない (= teamLoginKey の入力を強制)。
  useEffect(() => {
    if (session) return;
    if (config.mode !== "dev-mock") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") !== "1") return;
    void login("demo-team");
  }, [session, config.mode, login]);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  // Issue #859: session 存在中のみ 6 時間 idle timer を回す。 user 操作で reset。
  useEffect(() => {
    if (!session) return;
    const resetTimer = (): void => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        logout();
      }, PARTICIPANT_IDLE_TIMEOUT_MS);
    };
    resetTimer();
    for (const evt of IDLE_EVENTS) {
      window.addEventListener(evt, resetTimer, { passive: true });
    }
    return () => {
      // resetTimer が必ず先に走り idleTimerRef を set 済なので、 cleanup 時の null 分岐は到達不能。
      /* v8 ignore next */
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      for (const evt of IDLE_EVENTS) {
        window.removeEventListener(evt, resetTimer);
      }
    };
  }, [session, logout]);

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
