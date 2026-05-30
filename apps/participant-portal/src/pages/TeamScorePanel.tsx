import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import type { LeaderboardResponse, ParticipantTeamView } from "../api/portal-client";
import { useT } from "../i18n";

/**
 * Home dashboard の「累計スコア / 順位 / 問題数 / 正解数」サマリーカード。
 * `HomePage` から切り出して、 各ページが描画する component だけに依存するようにした
 * (= 旧 Home.tsx の高結合を解消)。
 */
export function TeamScorePanel({
  view,
  leaderboard,
}: {
  view: ParticipantTeamView;
  leaderboard: LeaderboardResponse | null;
}) {
  const t = useT();
  const totalScore = view.problems.reduce((sum, p) => sum + p.score, 0);

  // Issue #1038 P1 #5: 順位 (Rank) を表示。 leaderboard.entries から isMyTeam を引き、
  // rank / 全 team 数を出す。 entries が空 (= 凍結中 / event 未配線 / 自 team が落ちた)
  // のときは「—」 表示にして UI を壊さない。
  const myEntry = leaderboard?.entries.find((e) => e.isMyTeam);
  // myEntry が取れるのは leaderboard 非 null のときだけなので `&& leaderboard` で narrow し、
  // 旧 `leaderboard?.entries.length ?? "—"` の不到達 fallback を消す。
  const rankValue =
    myEntry && leaderboard ? `${myEntry.rank} / ${leaderboard.entries.length}` : "—";

  return (
    <Container header={<Header variant="h2">{t("home.team_score_header")}</Header>}>
      <KeyValuePairs
        columns={4}
        items={[
          {
            label: t("home.score_total"),
            value: (
              <Box variant="awsui-value-large" color="text-status-success">
                {totalScore} pt
              </Box>
            ),
          },
          {
            label: t("home.rank_label"),
            value: (
              <Box variant="awsui-value-large" color="text-status-info">
                {rankValue}
              </Box>
            ),
          },
          { label: t("home.score_problem_count"), value: String(view.problems.length) },
          {
            // Issue #821 / #822: 旧 \"deploy COMPLETE\" カウントから 「正解した問題数」 に
            // 変更する。 flag 問題は flagSubmitted=true、 非 flag (Battle) は score>0 を
            // 「解いた」 と扱う (= スコアを稼げてれば貢献あり)。
            label: t("home.score_completed_count"),
            value: String(
              view.problems.filter((p) => {
                if (p.scoring?.kind === "flag") return p.scoring.flagSubmitted === true;
                return p.score > 0;
              }).length,
            ),
          },
        ]}
      />
    </Container>
  );
}
