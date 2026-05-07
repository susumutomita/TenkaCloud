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
  getPortalMe,
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
  /** Home の flag 提出後に呼ばれて即時再フェッチする経路。 */
  readonly refresh: () => Promise<void>;
}

const Ctx = createContext<TeamViewState>({
  view: null,
  error: null,
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

/**
 * Authenticated 領域 (`ShellLayout`) の中で 1 度だけ動く polling を提供する Context。
 *
 * Home page (累計スコアパネル + ProblemCard) と TopNav (Score / Rank widget) が同じ
 * `/portal/me` レスポンスを共有することで、polling が 2 つに増えるのを防ぐ。
 *
 * `mode === "dev-mock"` のときは backend を叩かない。session が無いときも polling
 * 起動しない (= /login や /setup の guarded 外で何もしない)。
 *
 * 全 problem が FAILED / DELETED に到達したら polling を停止する (`stopPollingRef`)。
 * 既存の Home polling と同じ条件。
 */
export function TeamViewProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";
  const [view, setView] = useState<ParticipantTeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopPollingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    try {
      const next = await getPortalMe(config.apiBaseUrl, sessionToken);
      setView((prev) => (viewIsUnchanged(prev, next) ? prev : next));
      setError(null);
      if (next.problems.every((p) => p.status === "FAILED" || p.status === "DELETED")) {
        stopPollingRef.current = true;
      }
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
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

  return <Ctx.Provider value={{ view, error, refresh }}>{children}</Ctx.Provider>;
}
