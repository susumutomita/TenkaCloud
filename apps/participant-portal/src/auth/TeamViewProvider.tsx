import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
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
import { useIsMock } from "../config-context";
import { countUnread, loadLastSeenAt, saveLastSeenAt } from "../lib/notifications-storage";
import { useAuth } from "./AuthProvider";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";

// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒は 12 req/min/team で過多、 競技中に
// N 競技者 = N team × 12 = N×12 req/min で participant-portal Lambda + DDB を圧迫していた)。
const POLL_INTERVAL_MS = 30_000;
/**
 * Notifications だけは 60 秒間隔で polling する (ADR-006 D3 + codex review)。
 * Events table は 1 RCU PROVISIONED なので、N 競技者 × 5 秒 polling で簡単に throttle
 * を引き起こす。Score / Leaderboard と同じ tick (5 秒) には乗せない。
 */
const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

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
  /**
   * `/notifications` page を開いたときに呼ぶ。`occurredAt` を localStorage と Context
   * 両方に書き込み、TopNav 未読 badge を **次の polling tick を待たず即時 0 化** する
   * (codex review)。
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
  markNotificationsSeen: () => {
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
export function viewIsUnchanged(
  prev: ParticipantTeamView | null,
  next: ParticipantTeamView,
): boolean {
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
      p.deployLog?.cursor !== n.deployLog?.cursor ||
      JSON.stringify(p.stackOutputs) !== JSON.stringify(n.stackOutputs)
    ) {
      return false;
    }
  }
  return true;
}

export function notificationsAreUnchanged(
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

export function leaderboardIsUnchanged(
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

export type PortalMeRefreshDecision =
  | { readonly kind: "view"; readonly view: ParticipantTeamView; readonly stopPolling: boolean }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "auth-error" };

export type LeaderboardRefreshDecision =
  | { readonly kind: "leaderboard"; readonly leaderboard: LeaderboardResponse }
  | { readonly kind: "no-event" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "auth-error" };

function errorMessage(err: unknown): string {
  return toErrorMessage(err);
}

function shouldStopProblemPolling(view: ParticipantTeamView): boolean {
  return view.problems.every((p) => p.status === "FAILED" || p.status === "DELETED");
}

export function toPortalMeRefreshDecision(
  result: PromiseSettledResult<ParticipantTeamView>,
): PortalMeRefreshDecision {
  if (result.status === "fulfilled") {
    return {
      kind: "view",
      view: result.value,
      stopPolling: shouldStopProblemPolling(result.value),
    };
  }
  if (result.reason instanceof PortalAuthError) return { kind: "auth-error" };
  return { kind: "error", message: errorMessage(result.reason) };
}

export function toLeaderboardRefreshDecision(
  result: PromiseSettledResult<LeaderboardResponse | undefined>,
): LeaderboardRefreshDecision {
  if (result.status === "fulfilled") {
    return result.value === undefined
      ? { kind: "no-event" }
      : { kind: "leaderboard", leaderboard: result.value };
  }
  if (result.reason instanceof PortalAuthError) return { kind: "auth-error" };
  return { kind: "error", message: errorMessage(result.reason) };
}

/**
 * Authenticated 領域 (`ShellLayout`) の中で 1 度だけ動く polling を提供する Context。
 *
 * Polling は **2 系統** で動かす:
 *   - 5 秒 tick: `/portal/me` + `/portal/leaderboard` (= score / rank の即時感重視)
 *   - 60 秒 tick: `/portal/me/notifications` (= ADR-006 D3、Events table 1 RCU 保護)
 *
 * `mode === "dev-mock"` のときは backend を叩かない。session が無いときも polling
 * 起動しない (= /login や /setup の guarded 外で何もしない)。
 *
 * 全 problem が FAILED / DELETED に到達したら 5s tick の polling を停止する
 * (`stopPollingRef`)。Notifications 側は event 終了後も配信され得るため止めない。
 */
export function TeamViewProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  // codex review: `lastSeenAt` を eventId scope にして「同 browser で別 event ログイン
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
  const stopPollingRef = useRef(false);

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

  /** 5 秒 tick: `/portal/me` + `/portal/leaderboard`。Notifications は別系統。 */
  const refresh = useCallback(async () => {
    if (isMock || !sessionToken) return;
    const [meResult, leaderboardResult] = await Promise.allSettled([
      getPortalMe(config.apiBaseUrl, sessionToken),
      getLeaderboard(config.apiBaseUrl, sessionToken),
    ]);

    if (!applyPortalMeDecision(toPortalMeRefreshDecision(meResult))) return;
    applyLeaderboardDecision(toLeaderboardRefreshDecision(leaderboardResult));
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

  // me + leaderboard polling は usePolling に寄せず手書きのまま残す: 全 problem が terminal に
  // 達したら次 tick を skip する `stopPollingRef` gate (= timer 制御ではなく業務的な停止条件) を
  // 持ち、 enabled gate だけでは表現できないため (= usePolling の責務範囲外)。
  useEffect(() => {
    if (isMock || !sessionToken) return;
    stopPollingRef.current = false;
    // 全 problem が terminal に達したら polling を止める。 旧 `cancelled` flag は await の
    // 前で評価され不到達だった (= clearInterval が teardown を担う) ので撤去。
    const tick = async () => {
      if (stopPollingRef.current) return;
      await refresh();
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isMock, sessionToken, refresh]);

  // notifications は単純な「即時 + interval + cleanup」 なので usePolling (web-kit) に集約 (#1418 DRY)。
  // enabled gate により refreshNotifications 冒頭の同条件 guard は不到達のまま (= v8 ignore 維持)。
  usePolling(refreshNotifications, NOTIFICATIONS_POLL_INTERVAL_MS, {
    enabled: !isMock && Boolean(sessionToken),
  });

  // codex review P3: page を開いた瞬間の既読化を **localStorage と Context state 両方** に
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
        markNotificationsSeen,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
