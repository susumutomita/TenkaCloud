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
  getPortalMe,
  type LeaderboardResponse,
  type ParticipantProblemView,
  type ParticipantTeamView,
  PortalAuthError,
} from "../api/portal-client";
import type { AppConfig } from "../config";
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
  /** Home の flag 提出後に呼ばれて即時再フェッチする経路。 */
  readonly refresh: () => Promise<void>;
}

const Ctx = createContext<TeamViewState>({
  view: null,
  error: null,
  leaderboard: null,
  leaderboardError: null,
  leaderboardNoEvent: false,
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
  const stopPollingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    const [meResult, leaderboardResult] = await Promise.allSettled([
      getPortalMe(config.apiBaseUrl, sessionToken),
      getLeaderboard(config.apiBaseUrl, sessionToken),
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

  return (
    <Ctx.Provider
      value={{ view, error, leaderboard, leaderboardError, leaderboardNoEvent, refresh }}
    >
      {children}
    </Ctx.Provider>
  );
}
