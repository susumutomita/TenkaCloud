import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import {
  getLeaderboard,
  type LeaderboardEntry,
  type LeaderboardResponse,
  PortalAuthError,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 5_000;

/**
 * Event scope の team ランキング。/portal/leaderboard を 5 秒間隔で polling し、
 * Cloudscape Table で rank / teamName / score / progress を表示する。
 *
 * 自チームは `isMyTeam=true` のセル背景を強調 (= AWS JAM 風)。
 *
 * dev-mock モードでは backend を叩かず placeholder を出す (Home と同じ慣習)。
 */
export function ScoreboardPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isBackend = config.mode === "backend";

  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const tick = useCallback(async () => {
    if (!isBackend || !sessionToken) return;
    try {
      const next = await getLeaderboard(config.apiBaseUrl, sessionToken);
      if (next === undefined) {
        // 404 = Phase 1 以前の旧 deployment (eventId 無し)。leaderboard 不能。
        setNotFound(true);
        setData(null);
      } else {
        setNotFound(false);
        setData(next);
      }
      setError(null);
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
    const run = async () => {
      if (cancelled) return;
      await tick();
    };
    void run();
    const interval = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isBackend, sessionToken, tick]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`${config.eventTitle} のリアルタイム順位 (${POLL_INTERVAL_MS / 1000} 秒ごと自動更新)`}
      >
        Scoreboard
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}
      {notFound && (
        <Alert type="info" header="このチームには Event が紐づいていません">
          旧式の deployment (Phase 1 以前) は event 単位の集計に対応していません。
        </Alert>
      )}
      {isBackend && !data && !error && !notFound && (
        <Box textAlign="center" padding="l">
          <Spinner /> 状態を取得中…
        </Box>
      )}

      {data && (
        <Container header={<Header variant="h2">{`参加チーム (${data.entries.length})`}</Header>}>
          <Table<LeaderboardEntry>
            variant="embedded"
            items={[...data.entries]}
            columnDefinitions={[
              {
                id: "rank",
                header: "順位",
                cell: (e) => (
                  <Box variant="strong" color={e.isMyTeam ? "text-status-success" : "inherit"}>
                    #{e.rank}
                  </Box>
                ),
                width: 80,
              },
              {
                id: "team",
                header: "チーム",
                cell: (e) => (
                  <Box variant={e.isMyTeam ? "strong" : "p"}>
                    {e.teamName}
                    {e.isMyTeam && (
                      <Box display="inline" variant="small" color="text-status-info">
                        {" "}
                        (あなた)
                      </Box>
                    )}
                  </Box>
                ),
              },
              {
                id: "score",
                header: "Score",
                cell: (e) => (
                  <Box variant="strong" color="text-status-success">
                    {e.score} pt
                  </Box>
                ),
              },
              {
                id: "progress",
                header: "完了 / 全体",
                cell: (e) => `${e.completedProblems} / ${e.totalProblems}`,
                width: 120,
              },
            ]}
            empty={<Box>参加チームがありません</Box>}
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
