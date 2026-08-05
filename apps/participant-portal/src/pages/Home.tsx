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
   * [#2882] local モードのホームは、 フラットな問題一覧ではなく講座トラックへ送る。
   *
   * トラック表示も推奨する次の 1 問 (#2790) も既に存在していたのに、 ホームの主ボタンが
   * 常に `/problems` を指していたため、 学習者は 71 件の平らな一覧に着いて「何をやればいいか
   * 分からない」で止まっていた。 作ってある道に案内していなかっただけ。
   *
   * 次の 1 問は難易度順ではなくトラック順 (`recommendedNext`) で選ぶ。 前者はカタログ全体を
   * 母数にするので、 トラックを進めている人には無関係な問題を指しうる。
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
       *  running / ended)。 視線は header → next action → 累計スコア → 推移 → 一覧 の順。 */}
      <NextActionHero view={view} leaderboard={leaderboard} />

      {view && <TeamScorePanel view={view} leaderboard={leaderboard} />}

      {/* Audit table #12: 競技開始からのスコア推移を 折れ線グラフで可視化 (= dashboard 中段)。 */}
      {!isMock && sessionToken && view && view.problems.length > 0 && (
        <ScoreTimelineChart apiBaseUrl={config.apiBaseUrl} sessionToken={sessionToken} />
      )}

      {/* Audit table #10: ホームは dashboard。 問題詳細 (ProblemPanel) を embed しない (=
       *  「一等地に何を出すか」 のティアリング、 問題の deep dive は /problems から)。 */}
      {view && view.problems.length > 0 && courseNext && (
        // [#2882] 講座トラックがある (= local) ときは、 件数ではなく「次の 1 問」を出す。
        // 71 件という数字は、 順に進めたい人には助けではなく圧になる。
        <Container header={<Header variant="h2">{t("home.course_next_header")}</Header>}>
          <SpaceBetween size="m">
            <Box>
              {courseNext.week === undefined
                ? t("home.course_next_body", { name: courseNext.name })
                : t("home.course_next_body_week", {
                    name: courseNext.name,
                    week: courseNext.week,
                  })}
            </Box>
            <SpaceBetween size="xs" direction="horizontal">
              <Button variant="primary" onClick={() => navigate("/course-tracks")}>
                {t("home.course_next_button")}
              </Button>
              <Button variant="link" onClick={() => navigate("/problems")}>
                {t("home.quests_quick_link_button")}
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      )}

      {view && view.problems.length > 0 && !courseNext && (
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
