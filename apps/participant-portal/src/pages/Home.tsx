import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { EmptyState, ErrorState, LoadingState } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { NextActionHero } from "../components/NextActionHero";
import { ScoreTimelineChart } from "../components/ScoreTimelineChart";
import type { AppConfig } from "../config";
import { showsCourseTracks } from "../config";
import { useIsMock } from "../config-context";
import { buildCourseTracks, toProblemProgress } from "../data/course-track";
import { listProblemCatalog } from "../data/problems";
import { useT } from "../i18n";
import { TeamScorePanel } from "./TeamScorePanel";

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

  /**
   * 難易度順・表示順で選ぶ方向は採らない — どちらもカタログ全体を母数にするので、 講座を
   * 順に進めている人には無関係な問題が「次にやること」に出る (実際にチュートリアルの途中で
   * 別トラックの問題が推薦された)。 トラックが next を持っているなら、 それがその人の次。
   */
  const courseNext = useMemo(() => {
    if (!showsCourseTracks(config.cloudMode)) return undefined;
    const tracks = buildCourseTracks(listProblemCatalog(), toProblemProgress(view?.problems ?? []));
    return tracks.find((track) => track.recommendedNext)?.recommendedNext;
  }, [config.cloudMode, view?.problems]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("home.welcome_description", { eventTitle: config.eventTitle })}
      >
        {t("home.welcome", { teamName })}
      </Header>

      {error && (
        // Issue #1366: 共有 ErrorState (DESIGN-SYSTEM 9 章) に統一。 raw Alert + raw string を廃止。
        <ErrorState title={t("app.fetch_status_failed")} hint={error} />
      )}
      {!isMock && !view && !error && <LoadingState label={t("app.loading")} />}

      {/* Issue #1349: 「次にやること」 hero を一等地に置く (= 3 状態 = not_started /
       *  running / ended)。 #2900: real の running だけは直下の問題一覧導線と重複するため隠す。 */}
      <NextActionHero
        cloudMode={config.cloudMode}
        view={view}
        leaderboard={leaderboard}
        preferredNextProblemId={courseNext?.problemId}
      />

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
        // Issue #1366: 「問題が無い」 という空状態。 Container + 本文だけだと「次に何をするか」 が
        // 分からないので DESIGN-SYSTEM 8 章準拠の EmptyState に置換。 primary action は scoreboard へ
        // (= 観戦モード)。
        <Container header={<Header variant="h2">{t("home.no_problems_header")}</Header>}>
          <EmptyState
            headline={t("home.no_problems_header")}
            body={t("home.no_problems_body")}
            primaryAction={{
              label: t("home.quests_quick_link_button"),
              onClick: () => navigate("/scoreboard"),
            }}
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
