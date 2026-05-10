import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  getLeaderboard,
  getNotifications,
  getPortalMe,
  type LeaderboardResponse,
  type NotificationsResponse,
  type ParticipantProblemView,
  type ParticipantTeamView,
  PortalAuthError,
} from "../api/portal-client";
import type { AppConfig } from "../config";
import { countUnread, loadLastSeenAt } from "../lib/notifications-storage";
import { useAuth } from "./AuthProvider";

const POLL_INTERVAL_MS = 5_000;

interface TeamViewState {
  readonly view: ParticipantTeamView | null;
  readonly error: string | null;
  /**
   * Event scope の leaderboard。Phase 1 以前 (eventId 無しの jobId-based deployment)
   * では `noEvent: true` を返す。Scoreboard / TopNav が共有する。
   */
  readonly leaderboard: LeaderboardResponse | null;
  readonly leaderboardError: string | null;
  readonly leaderboardNoEvent: boolean;
  /**
   * 自 event の運営通知 (ADR-006)。Phase 1 以前 (eventId 無し) では
   * `notificationsNoEvent: true` を返して null。
   */
  readonly notifications: NotificationsResponse | null;
  readonly notificationsError: string | null;
  readonly notificationsNoEvent: boolean;
  /** TopNav 未読 badge 用。lastSeenAt は localStorage、polling 毎に再計算。 */
  readonly unreadNotificationCount: number;
  /** Home の flag 提出後に呼ばれて即時再フェッチする経路。 */
  readonly refresh: () => Promise<void>;
}

const Ctx = createContext<TeamViewState>({
  view: null,
  error: null,
  leaderboard: null,
  leaderboardError: null,
  leaderboardNoEvent: false,
  notifications: null,
  notificationsError: null,
  notificationsNoEvent: false,
  unreadNotificationCount: 0,
  refresh: async () => {
    /* default no-op */
  },
});

export function useTeamView(): TeamViewState {
  return useContext(Ctx);
}

/**
 * Polling 結果が前回と意味的に同じなら true → setView を skip し React 再 render を抑制。
 * Home / TopNav の両方が context 経由で再 render するため、no-op 検出は重要。
 */
function viewIsUnchanged(prev: ParticipantTeamView | null, next: ParticipantTeamView): boolean {
  if (!prev) return false;
  if (prev.team.teamName !== next.team.teamName) return false;
  if (prev.problems.length !== next.problems.length) return false;
  for (let i = 0; i < prev.problems.length; i++) {
    const p = prev.problems[i] as ParticipantProblemView;
    const n = next.problems[i] as ParticipantProblemView;
    if (
      p.jobId !== n.jobId ||
      p.status !== n.status ||
      p.score !== n.score ||
      p.lastScoredAt !== n.lastScoredAt ||
      p.lastResult !== n.lastResult ||
      p.scoring?.flagSubmitted !== n.scoring?.flagSubmitted ||
      p.failureReason !== n.failureReason ||
      JSON.stringify(p.stackOutputs) !== JSON.stringify(n.stackOutputs)
    ) {
      return false;
    }
  }
  return true;
}

function notificationsAreUnchanged(
  prev: NotificationsResponse | null,
  next: NotificationsResponse,
): boolean {
  if (!prev) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.items.length !== next.items.length) return false;
  for (let i = 0; i < prev.items.length; i++) {
    const a = prev.items[i];
    const b = next.items[i];
    if (!a || !b) return false;
    if (a.notificationId !== b.notificationId) return false;
    // title / body / severity / occurredAt は immutable (= 編集 API 無し) なので
    // notificationId 一致なら内容も同一とみなす。
  }
  return true;
}

function leaderboardIsUnchanged(
  prev: LeaderboardResponse | null,
  next: LeaderboardResponse,
): boolean {
  if (!prev) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.entries.length !== next.entries.length) return false;
  for (let i = 0; i < prev.entries.length; i++) {
    const a = prev.entries[i];
    const b = next.entries[i];
    if (!a || !b) return false;
    if (
      a.rank !== b.rank ||
      a.teamId !== b.teamId ||
      a.teamName !== b.teamName ||
      a.score !== b.score ||
      a.completedProblems !== b.completedProblems ||
      a.totalProblems !== b.totalProblems ||
      a.isMyTeam !== b.isMyTeam
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Authenticated 領域 (`ShellLayout`) の中で 1 度だけ動く polling を提供する Context。
 *
 * Home page (累計スコアパネル + ProblemCard) / TopNav (Score/Rank widget) / Scoreboard
 * page が同じ `/portal/me` + `/portal/leaderboard` レスポンスを共有することで、
 * polling が複数に増えるのを防ぐ。両 endpoint は 5 秒 tick 内で `Promise.allSettled`
 * 並列 fetch する (= 一方が遅れても他方は更新)。
 *
 * `mode === "dev-mock"` のときは backend を叩かない。session が無いときも polling
 * 起動しない (= /login や /setup の guarded 外で何もしない)。
 *
 * 全 problem が FAILED / DELETED に到達したら polling を停止する (`stopPollingRef`)。
 */
export function TeamViewProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";
  const [view, setView] = useState<ParticipantTeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [leaderboardNoEvent, setLeaderboardNoEvent] = useState(false);
  const [notifications, setNotifications] = useState<NotificationsResponse | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsNoEvent, setNotificationsNoEvent] = useState(false);
  // localStorage の lastSeenAt は polling 内で読み直す必要は無い (= 同 tab 内で
  // /notifications を開いた瞬間に saveLastSeenAt → 直後の useEffect で再計算)。
  // ただし別 tab で更新された値も拾えると親切なので 60s tick で読み直す。
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() => loadLastSeenAt());
  const stopPollingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    const [meResult, leaderboardResult, notificationsResult] = await Promise.allSettled([
      getPortalMe(config.apiBaseUrl, sessionToken),
      getLeaderboard(config.apiBaseUrl, sessionToken),
      getNotifications(config.apiBaseUrl, sessionToken),
    ]);

    if (meResult.status === "fulfilled") {
      const next = meResult.value;
      setView((prev) => (viewIsUnchanged(prev, next) ? prev : next));
      setError(null);
      if (next.problems.every((p) => p.status === "FAILED" || p.status === "DELETED")) {
        stopPollingRef.current = true;
      }
    } else {
      const err = meResult.reason;
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }

    if (leaderboardResult.status === "fulfilled") {
      const next = leaderboardResult.value;
      if (next === undefined) {
        // 404 = Phase 1 以前の旧 deployment (eventId 無し) → leaderboard 不能
        setLeaderboardNoEvent(true);
        setLeaderboard(null);
      } else {
        setLeaderboardNoEvent(false);
        setLeaderboard((prev) => (leaderboardIsUnchanged(prev, next) ? prev : next));
      }
      setLeaderboardError(null);
    } else {
      const err = leaderboardResult.reason;
      // Auth エラーは meResult 側で処理済 (= 同じ token を使っているので)
      if (!(err instanceof PortalAuthError)) {
        setLeaderboardError(err instanceof Error ? err.message : String(err));
      }
    }

    if (notificationsResult.status === "fulfilled") {
      const next = notificationsResult.value;
      if (next === undefined) {
        // 404 = Phase 1 以前の旧 deployment (eventId 無し) → notifications 配信対象外
        setNotificationsNoEvent(true);
        setNotifications(null);
      } else {
        setNotificationsNoEvent(false);
        setNotifications((prev) => (notificationsAreUnchanged(prev, next) ? prev : next));
      }
      setNotificationsError(null);
      // 別 tab 経由で更新された lastSeenAt を tick 毎に拾い直す (同 tab は useEffect 経由)。
      setLastSeenAt(loadLastSeenAt());
    } else {
      const err = notificationsResult.reason;
      if (!(err instanceof PortalAuthError)) {
        setNotificationsError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [isBackend, sessionToken, config.apiBaseUrl, auth]);

  useEffect(() => {
    if (!isBackend || !sessionToken) return;
    let cancelled = false;
    stopPollingRef.current = false;
    const tick = async () => {
      if (cancelled || stopPollingRef.current) return;
      await refresh();
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isBackend, sessionToken, refresh]);

  const unreadNotificationCount = countUnread(notifications?.items ?? [], lastSeenAt);

  return (
    <Ctx.Provider
      value={{
        view,
        error,
        leaderboard,
        leaderboardError,
        leaderboardNoEvent,
        notifications,
        notificationsError,
        notificationsNoEvent,
        unreadNotificationCount,
        refresh,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
