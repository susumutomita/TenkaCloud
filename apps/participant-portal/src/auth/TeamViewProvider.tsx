import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
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
  type ParticipantTeamView,
  PortalAuthError,
} from "../api/portal-client";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { NOTIFICATIONS_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from "../constants/polling";
import { countUnread, loadLastSeenAt, saveLastSeenAt } from "../lib/notifications-storage";
import { useAuth } from "./AuthProvider";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";
import {
  type LeaderboardRefreshDecision,
  leaderboardIsUnchanged,
  notificationsAreUnchanged,
  type PortalMeRefreshDecision,
  toLeaderboardRefreshDecision,
  toPortalMeRefreshDecision,
  viewIsUnchanged,
} from "./team-view-diff";

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
   * 自 event の運営通知。eventId を持たない旧 deployment では
   * `notificationsNoEvent: true` を返して null。
   */
  readonly notifications: NotificationsResponse | null;
  readonly notificationsError: string | null;
  readonly notificationsNoEvent: boolean;
  /** TopNav 未読 badge 用。lastSeenAt は localStorage、polling 毎に再計算。 */
  readonly unreadNotificationCount: number;
  /** Home の flag 提出後に呼ばれて即時再フェッチする経路。 */
  readonly refresh: () => Promise<void>;
  /** 手動更新中 / 初回更新中なら true。重複 refresh は同じ in-flight promise を共有する。 */
  readonly isRefreshing: boolean;
  /** 30 秒 status polling。コスト抑制のため default false。 */
  readonly autoRefreshEnabled: boolean;
  readonly setAutoRefreshEnabled: Dispatch<SetStateAction<boolean>>;
  /**
   * `/notifications` page を開いたときに呼ぶ。`occurredAt` を localStorage と Context
   * 両方に書き込み、TopNav 未読 badge を **次の polling tick を待たず即時 0 化** する。
   */
  readonly markNotificationsSeen: (occurredAt: string) => void;
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
  isRefreshing: false,
  autoRefreshEnabled: false,
  setAutoRefreshEnabled: () => {
    /* default no-op */
  },
  markNotificationsSeen: () => {
    /* default no-op */
  },
});

export function useTeamView(): TeamViewState {
  return useContext(Ctx);
}

// Issue #2222: the pure diff-decision functions below now live in
// team-view-diff.ts; re-exported here so existing imports of TeamViewProvider
// (this module's public interface) don't need to change. Issue #2283 folded the
// `progression` (lock/unlock) diff into that module's `viewIsUnchanged`.
export type { LeaderboardRefreshDecision, PortalMeRefreshDecision };
export {
  leaderboardIsUnchanged,
  notificationsAreUnchanged,
  toLeaderboardRefreshDecision,
  toPortalMeRefreshDecision,
  viewIsUnchanged,
};

/**
 * Authenticated 領域 (`ShellLayout`) の共有 team view state を提供する Context。
 *
 * Polling は cost guardrail 優先で制御する:
 *   - mount 時に `/portal/me` + `/portal/leaderboard` を 1 回だけ読む
 *   - 30 秒 status polling は opt-in (`autoRefreshEnabled`)。default false。
 *   - notifications は 60 秒 tick のまま低頻度で分離 (= unread badge 用)
 *
 * `mode === "dev-mock"` のときは backend を叩かない。session が無いときも polling
 * 起動しない (= /login や /setup の guarded 外で何もしない)。
 *
 * 全 problem が FAILED / DELETED に到達したら opt-in status refresh を停止する
 * (`stopPollingRef`)。Notifications 側は event 終了後も配信され得るため止めない。
 */
export function TeamViewProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  // `lastSeenAt` を eventId scope にして「同 browser で別 event ログイン
  // 後、前 event の lastSeen を引きずって新 event の通知を silent 既読化」を防ぐ。
  const eventIdForKey = auth.session?.eventId ?? "";
  const isMock = useIsMock();
  const [view, setView] = useState<ParticipantTeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [leaderboardNoEvent, setLeaderboardNoEvent] = useState(false);
  const [notifications, setNotifications] = useState<NotificationsResponse | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsNoEvent, setNotificationsNoEvent] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() => loadLastSeenAt(eventIdForKey));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const stopPollingRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const applyPortalMeDecision = useCallback(
    (decision: PortalMeRefreshDecision): boolean => {
      if (decision.kind === "auth-error") {
        auth.logout();
        return false;
      }
      if (decision.kind === "error") {
        setError(decision.message);
        return true;
      }
      setView((prev) => (viewIsUnchanged(prev, decision.view) ? prev : decision.view));
      setError(null);
      if (decision.stopPolling) stopPollingRef.current = true;
      return true;
    },
    [auth],
  );

  const applyLeaderboardDecision = useCallback((decision: LeaderboardRefreshDecision): void => {
    if (decision.kind === "auth-error") return;
    if (decision.kind === "error") {
      setLeaderboardError(decision.message);
      return;
    }
    if (decision.kind === "no-event") {
      // 404 = Phase 1 以前の旧 deployment (eventId 無し) → leaderboard 不能
      setLeaderboardNoEvent(true);
      setLeaderboard(null);
    } else {
      setLeaderboardNoEvent(false);
      setLeaderboard((prev) =>
        leaderboardIsUnchanged(prev, decision.leaderboard) ? prev : decision.leaderboard,
      );
    }
    setLeaderboardError(null);
  }, []);

  /** `/portal/me` + `/portal/leaderboard`。Notifications は別系統。 */
  const refresh = useCallback(async () => {
    if (isMock || !sessionToken) return;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const run = (async () => {
      setIsRefreshing(true);
      try {
        const [meResult, leaderboardResult] = await Promise.allSettled([
          getPortalMe(config.apiBaseUrl, sessionToken),
          getLeaderboard(config.apiBaseUrl, sessionToken),
        ]);

        if (!applyPortalMeDecision(toPortalMeRefreshDecision(meResult))) return;
        applyLeaderboardDecision(toLeaderboardRefreshDecision(leaderboardResult));
      } finally {
        refreshInFlightRef.current = null;
        setIsRefreshing(false);
      }
    })();
    refreshInFlightRef.current = run;
    return run;
  }, [isMock, sessionToken, config.apiBaseUrl, applyPortalMeDecision, applyLeaderboardDecision]);

  /** 60 秒 tick: `/portal/me/notifications` 専用。Events table の RCU を守る。 */
  const refreshNotifications = useCallback(async () => {
    // 呼び出し元の useEffect が同条件を gate 済み (refresh と違い context に露出しない) ため
    // true 分岐は不到達。 防御的に残す。
    /* v8 ignore next */
    if (isMock || !sessionToken) return;
    try {
      const next = await getNotifications(config.apiBaseUrl, sessionToken);
      if (next === undefined) {
        // 404 = Phase 1 以前の旧 deployment (eventId 無し) → notifications 配信対象外
        setNotificationsNoEvent(true);
        setNotifications(null);
      } else {
        setNotificationsNoEvent(false);
        setNotifications((prev) => (notificationsAreUnchanged(prev, next) ? prev : next));
      }
      setNotificationsError(null);
      // 別 tab 経由で更新された lastSeenAt を tick 毎に拾い直す。
      setLastSeenAt(loadLastSeenAt(eventIdForKey));
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setNotificationsError(toErrorMessage(err));
    }
  }, [isMock, sessionToken, config.apiBaseUrl, auth, eventIdForKey]);

  // LP 「モックで試す」 動線: dev-mock mode + session 在りのとき、 backend API が無くても
  // 各画面が空にならないよう固定 fixture を 1 度だけ seed する。 polling は走らない。
  // production (= backend mode) では `if (isMock) return` ガードで素通り。
  useEffect(() => {
    if (!isMock) return;
    if (!sessionToken) return;
    if (view) return;
    setView(DEV_MOCK_TEAM_VIEW);
    setLeaderboard(DEV_MOCK_LEADERBOARD);
    setNotifications(DEV_MOCK_NOTIFICATIONS);
  }, [isMock, sessionToken, view]);

  // status は mount 時に 1 回だけ取得する。30s 継続 polling は DynamoDB 負荷を増やすため
  // opt-in に分離する。
  useEffect(() => {
    if (isMock || !sessionToken) return;
    stopPollingRef.current = false;
    void refresh();
  }, [isMock, sessionToken, refresh]);

  // me + leaderboard auto refresh は手書きのまま残す: 全 problem が terminal に
  // 達したら次 tick を skip する `stopPollingRef` gate (= timer 制御ではなく業務的な停止条件) を
  // 持ち、 enabled gate だけでは表現できないため (= usePolling の責務範囲外)。
  useEffect(() => {
    if (!autoRefreshEnabled || isMock || !sessionToken) return;
    const tick = async () => {
      if (stopPollingRef.current) return;
      await refresh();
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefreshEnabled, isMock, sessionToken, refresh]);

  // notifications は単純な「即時 + interval + cleanup」 なので usePolling (web-kit) に集約 (#1418 DRY)。
  // enabled gate により refreshNotifications 冒頭の同条件 guard は不到達のまま (= v8 ignore 維持)。
  usePolling(refreshNotifications, NOTIFICATIONS_POLL_INTERVAL_MS, {
    enabled: !isMock && Boolean(sessionToken),
  });

  // page を開いた瞬間の既読化を **localStorage と Context state 両方** に
  // 反映して、TopNav 未読 badge が次の 60s tick を待たず即 0 化する。
  const markNotificationsSeen = useCallback(
    (occurredAt: string) => {
      if (!eventIdForKey || typeof occurredAt !== "string" || occurredAt.length === 0) return;
      saveLastSeenAt(eventIdForKey, occurredAt);
      setLastSeenAt((prev) => (prev !== null && prev >= occurredAt ? prev : occurredAt));
    },
    [eventIdForKey],
  );

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
        isRefreshing,
        autoRefreshEnabled,
        setAutoRefreshEnabled,
        markNotificationsSeen,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
