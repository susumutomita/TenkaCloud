import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import type { LeaderboardResponse, ParticipantTeamView } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { ScoreTimelineChart } from "../components/ScoreTimelineChart";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";

/**
 * Audit table #11: 超長 username (= Cognito sub-derived 名等) が header 全幅を占有して
 * layout を壊す問題への対策。 長すぎる名前は ~24 文字で truncate + "…" を付ける (Cloudscape
 * の Box variant に text overflow control が無いため自前で行う)。 詳細は detail 画面 / プロファイル
 * 画面で fullName を出す経路を別途用意する。
 */
const TEAM_NAME_MAX = 24;
function truncateTeamName(name: string): string {
  if (name.length <= TEAM_NAME_MAX) return name;
  return `${name.slice(0, TEAM_NAME_MAX)}…`;
}

export function HomePage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const isMock = useIsMock();
  const t = useT();
  const navigate = useNavigate();
  // Polling は ShellLayout の TeamViewProvider で一括管理される (TopNav も同じデータを共有)。
  const { view, error, leaderboard } = useTeamView();

  const teamNameRaw = view?.team.teamName ?? auth.session?.teamName ?? "(unknown)";
  const teamName = truncateTeamName(teamNameRaw);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("home.welcome_description", { eventTitle: config.eventTitle })}
      >
        {t("home.welcome", { teamName })}
      </Header>

      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {!isMock && !view && !error && <Box>{t("app.loading")}</Box>}

      {view && <TeamScorePanel view={view} leaderboard={leaderboard} />}

      {/* Audit table #12: 競技開始からのスコア推移を 折れ線グラフで可視化 (= dashboard 中段)。 */}
      {!isMock && sessionToken && view && view.problems.length > 0 && (
        <ScoreTimelineChart apiBaseUrl={config.apiBaseUrl} sessionToken={sessionToken} />
      )}

      {/* Audit table #10: ホームは dashboard。 問題詳細 (ProblemPanel) を embed しない (=
       *  「一等地に何を出すか」 のティアリング、 問題の deep dive は /problems から)。 */}
      {view && view.problems.length > 0 && (
        <Container header={<Header variant="h2">{t("home.quests_quick_link_header")}</Header>}>
          <SpaceBetween size="m">
            <Box>{t("home.quests_quick_link_body", { count: view.problems.length })}</Box>
            <Button variant="primary" onClick={() => navigate("/problems")}>
              {t("home.quests_quick_link_button")}
            </Button>
          </SpaceBetween>
        </Container>
      )}

      {view && view.problems.length === 0 && (
        <Container header={<Header variant="h2">{t("home.no_problems_header")}</Header>}>
          <Box>{t("home.no_problems_body")}</Box>
        </Container>
      )}
    </SpaceBetween>
  );
}

function TeamScorePanel({
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
  const rankValue = myEntry ? `${myEntry.rank} / ${leaderboard?.entries.length ?? "—"}` : "—";

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
