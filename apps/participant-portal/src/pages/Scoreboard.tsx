import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import type { LeaderboardEntry } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import { ResultCard } from "../components/ResultCard";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";

/**
 * Event scope の team ランキング。`TeamViewProvider` 経由の共有 leaderboard state を
 * そのまま表示するので、本 page は専用の polling を持たない (= TopNav / Home と同 source)。
 *
 * 自チームは `isMyTeam=true` のセル背景を強調 (= AWS JAM 風)。
 *
 * dev-mock モードでは backend を叩かず placeholder を出す (Home と同じ慣習)。
 */
export function ScoreboardPage({ config }: { config: AppConfig }) {
  const t = useT();
  const isMock = useIsMock();
  const { leaderboard, leaderboardError, leaderboardNoEvent } = useTeamView();

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("scoreboard.description", { eventTitle: config.eventTitle })}
      >
        {t("scoreboard.title")}
      </Header>

      {leaderboardError && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {leaderboardError}
        </Alert>
      )}
      {leaderboardNoEvent && (
        <Alert type="info" header={t("scoreboard.no_event_header")}>
          {t("scoreboard.no_event_body")}
        </Alert>
      )}
      {!isMock && !leaderboard && !leaderboardError && !leaderboardNoEvent && (
        <Box textAlign="center" padding="l">
          <Spinner /> {t("app.loading")}
        </Box>
      )}

      {/* Issue #1038 P1 #9: scoreboard freeze (= 終了 30 分前から最終結果まで非公開)。
       *   backend が scoreboardFrozen=true で entries 空配列を返してくる。 frontend は
       *   通常 table の代わりに「凍結中」 alert を出す。 競技終了後 (= now >= endsAt) は
       *   backend が scoreboardFrozen=false に戻すので、 最終結果は通常表示される。 */}
      {leaderboard?.scoreboardFrozen && (
        <Alert type="info" header={t("scoreboard.frozen_header")}>
          <Box variant="p">
            {t("scoreboard.frozen_body")}
            {leaderboard.endsAt && (
              <>
                <br />
                {t("scoreboard.frozen_ends_at_label")}: {" "}
                <code>{new Date(leaderboard.endsAt).toLocaleString()}</code>
              </>
            )}
          </Box>
        </Alert>
      )}

      {leaderboard && !leaderboard.scoreboardFrozen && (
        <Container
          header={
            <Header variant="h2">
              {t("scoreboard.entries_header", { count: leaderboard.entries.length })}
            </Header>
          }
        >
          <Table<LeaderboardEntry>
            variant="embedded"
            items={[...leaderboard.entries]}
            columnDefinitions={[
              {
                id: "rank",
                header: t("scoreboard.col_rank"),
                cell: (e: LeaderboardEntry) => (
                  <Box variant="strong" color={e.isMyTeam ? "text-status-success" : "inherit"}>
                    #{e.rank}
                  </Box>
                ),
                width: 80,
              },
              {
                id: "team",
                header: t("scoreboard.col_team"),
                cell: (e: LeaderboardEntry) => (
                  <Box variant={e.isMyTeam ? "strong" : "p"}>
                    {e.teamName}
                    {e.isMyTeam && (
                      <Box display="inline" variant="small" color="text-status-info">
                        {" "}
                        {t("scoreboard.you_suffix")}
                      </Box>
                    )}
                  </Box>
                ),
              },
              {
                id: "score",
                header: t("scoreboard.col_score"),
                cell: (e: LeaderboardEntry) => (
                  <Box variant="strong" color="text-status-success">
                    {e.score} pt
                  </Box>
                ),
              },
              {
                id: "progress",
                header: t("scoreboard.col_progress"),
                cell: (e: LeaderboardEntry) => `${e.completedProblems} / ${e.totalProblems}`,
                width: 120,
              },
            ]}
            empty={<Box>{t("scoreboard.empty")}</Box>}
          />
        </Container>
      )}

      {leaderboard && !leaderboard.scoreboardFrozen && (
        <ResultCard leaderboard={leaderboard} eventTitle={config.eventTitle} />
      )}
    </SpaceBetween>
  );
}
