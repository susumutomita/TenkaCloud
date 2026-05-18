import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import type { LeaderboardEntry } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";

/**
 * Event scope の team ランキング。`TeamViewProvider` 経由の共有 leaderboard polling を
 * そのまま表示するので、本 page は専用の polling を持たない (= TopNav / Home と同 source)。
 *
 * 自チームは `isMyTeam=true` のセル背景を強調 (= AWS JAM 風)。
 *
 * dev-mock モードでは backend を叩かず placeholder を出す (Home と同じ慣習)。
 */
export function ScoreboardPage({ config }: { config: AppConfig }) {
  const isBackend = config.mode === "backend";
  const { leaderboard, leaderboardError, leaderboardNoEvent } = useTeamView();

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`${config.eventTitle} のリアルタイム順位 (5 秒ごと自動更新)`}
      >
        Scoreboard
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {leaderboardError && (
        <Alert type="error" header="状態の取得に失敗しました">
          {leaderboardError}
        </Alert>
      )}
      {leaderboardNoEvent && (
        <Alert type="info" header="このチームには Event が紐づいていません">
          旧式の deployment (Phase 1 以前) は event 単位の集計に対応していません。
        </Alert>
      )}
      {isBackend && !leaderboard && !leaderboardError && !leaderboardNoEvent && (
        <Box textAlign="center" padding="l">
          <Spinner /> 状態を取得中…
        </Box>
      )}

      {/* Issue #1038 P1 #9: scoreboard freeze (= 終了 30 分前から最終結果まで非公開)。
       *   backend が scoreboardFrozen=true で entries 空配列を返してくる。 frontend は
       *   通常 table の代わりに「凍結中」 alert を出す。 競技終了後 (= now >= endsAt) は
       *   backend が scoreboardFrozen=false に戻すので、 最終結果は通常表示される。 */}
      {leaderboard?.scoreboardFrozen && (
        <Alert type="info" header="🔒 順位は終了 30 分前から凍結中">
          <Box variant="p">
            最後の駆け込みを防ぐため、 競技終了 30 分前から最終結果公開までは順位を非公開に
            しています。 競技終了後に最終順位を表示します。
            {leaderboard.endsAt && (
              <>
                <br />
                終了予定: <code>{new Date(leaderboard.endsAt).toLocaleString()}</code>
              </>
            )}
          </Box>
        </Alert>
      )}

      {leaderboard && !leaderboard.scoreboardFrozen && (
        <Container
          header={<Header variant="h2">{`参加チーム (${leaderboard.entries.length})`}</Header>}
        >
          <Table<LeaderboardEntry>
            variant="embedded"
            items={[...leaderboard.entries]}
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
