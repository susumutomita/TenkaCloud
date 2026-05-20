import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Cards from "@cloudscape-design/components/cards";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import type * as React from "react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { ParticipantProblemView, ParticipantScoringInfo } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";
import { findProblemMetadata } from "../data/problems";
import { useT } from "../i18n";
import { categoryOf } from "../lib/category";

/**
 * 競技者向けの 「解答状態」 (= 解けた / 解けてない)。 #821 / #822 で導入、 issue #34 で
 * 一覧カードの右上 icon に圧縮 (= ラベル無し、 視線を奪わない)。
 */
type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

function renderSubmissionState(
  problem: ParticipantProblemView,
  t: TFn,
): {
  readonly type: StatusIndicatorProps.Type;
  readonly label: string;
} {
  if (problem.status === "FAILED") return { type: "error", label: t("quests.submission_failed") };
  if (problem.status === "DELETED")
    return { type: "stopped", label: t("quests.submission_finished") };
  if (problem.status === "PENDING" || problem.status === "IN_PROGRESS") {
    return { type: "in-progress", label: t("quests.submission_preparing") };
  }
  if (problem.scoring?.kind === "flag") {
    if (problem.scoring.flagSubmitted)
      return { type: "success", label: t("quests.submission_cleared") };
    return { type: "pending", label: t("quests.submission_unsolved") };
  }
  return { type: "info", label: t("quests.submission_in_progress") };
}

type CategoryFilter = "all" | "battle" | "challenge";

function categoryBadge(scoring: ParticipantScoringInfo | undefined, uncategorizedLabel: string) {
  const cat = categoryOf(scoring);
  if (cat === "battle") return <Badge color="red">Battle</Badge>;
  if (cat === "challenge") return <Badge color="blue">Challenge</Badge>;
  return <Badge color="grey">{uncategorizedLabel}</Badge>;
}

/**
 * issue #4 (audit table): 一覧カードに見せるのは **タイトル / 難易度 / カテゴリ + 解答状態 icon** だけ。
 * Score / Region / NamePrefix / ParticipantViewerRoleArn / ParameterName / AWS Console ボタンは
 * 詳細画面に集約。 大会の戦略決定はカードを並べて 「どれをやるか」 を決める用途なので、 過剰な
 * 詳細を出すと逆に「どれを見ればよいかわからない」 を生む (= image #35 の指摘)。
 */
function difficultyBadge(problemId: string, t: TFn): React.ReactElement | null {
  const meta = findProblemMetadata(problemId);
  if (!meta) return null;
  return (
    <Badge color="grey">
      {t("quests.difficulty_label", { label: t(`quests.difficulty_${meta.difficulty}`) })}
    </Badge>
  );
}

/**
 * Issue #1000: 「解決済み」 か 「未解決」 か。 Challenge (flag) は flagSubmitted で判定、
 * Battle は採点が継続するので "unsolved" 軸に寄せる (= 取りこぼし防止、 #9 と同じ方針)。
 */
function isCleared(problem: ParticipantProblemView): boolean {
  return problem.scoring?.kind === "flag" && problem.scoring.flagSubmitted === true;
}

/**
 * 自チーム向け deploy 済問題のカタログ画面 (sidebar 「問題一覧」)。Home に対する
 * compact な navigation focus 版で、各問題の status / score / アクセス先 URL を
 * カード表示する。
 *
 * データ source は `useTeamView()` (= ShellLayout 内の `/portal/me` polling 結果を共有)。
 * 専用 polling は持たない (Home / TopNav と同じ context を使う)。
 *
 * Issue #1000: 旧 SegmentedControl (= 全て / 未解決 / クリア) は撤去、 未解決 と 解決済み を
 * 「section 分け」 で並列表示する。 未解決 section は常時 expand、 解決済み section は
 * ExpandableSection (= 初期 collapsed)、 ひと目で残タスクと既獲得を区別できる。
 */
export function QuestsPage({ config }: { config: AppConfig }) {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const t = useT();
  const isBackend = config.mode === "backend";
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const allProblems = useMemo(() => view?.problems ?? [], [view]);

  const counts = useMemo(() => {
    return {
      all: allProblems.length,
      battle: allProblems.filter((p) => categoryOf(p.scoring) === "battle").length,
      challenge: allProblems.filter((p) => categoryOf(p.scoring) === "challenge").length,
    };
  }, [allProblems]);

  const categoryFiltered = useMemo(() => {
    return allProblems.filter((p) => filter === "all" || categoryOf(p.scoring) === filter);
  }, [allProblems, filter]);

  const { unsolved, cleared } = useMemo(() => {
    const u: ParticipantProblemView[] = [];
    const c: ParticipantProblemView[] = [];
    for (const p of categoryFiltered) {
      if (isCleared(p)) c.push(p);
      else u.push(p);
    }
    return { unsolved: u, cleared: c };
  }, [categoryFiltered]);

  const renderCard = useMemo(
    () => ({
      header: (problem: ParticipantProblemView) => {
        const s = renderSubmissionState(problem, t);
        return (
          <SpaceBetween size="xs" direction="horizontal" alignItems="center">
            <Link
              fontSize="heading-m"
              href={`/problems/${encodeURIComponent(problem.jobId)}`}
              onFollow={(e) => {
                e.preventDefault();
                navigate(`/problems/${encodeURIComponent(problem.jobId)}`);
              }}
            >
              <code>{problem.problemId}</code>
            </Link>
            {categoryBadge(problem.scoring, t("quests.category_uncategorized"))}
            {difficultyBadge(problem.problemId, t)}
            <StatusIndicator type={s.type}>{s.label}</StatusIndicator>
          </SpaceBetween>
        );
      },
      sections: [],
    }),
    [navigate, t],
  );

  const emptyUnsolved = (
    <Container>
      <Box textAlign="center" padding="l">
        <Box variant="strong">{t("quests.empty_unsolved")}</Box>
        <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
          {t("quests.empty_unsolved_hint")}
        </Box>
      </Box>
    </Container>
  );

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("quests.header_description")}>
        {t("quests.header")}
      </Header>

      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}

      <SegmentedControl
        selectedId={filter}
        onChange={({ detail }) => setFilter(detail.selectedId as CategoryFilter)}
        options={[
          { id: "all", text: `${t("quests.filter_all")} (${counts.all})` },
          { id: "battle", text: `${t("quests.filter_battle")} (${counts.battle})` },
          { id: "challenge", text: `${t("quests.filter_challenge")} (${counts.challenge})` },
        ]}
        label={t("quests.filter_label")}
      />

      {/* Issue #1000: 未解決 section を常時 expand で先頭に並べる */}
      <Container
        header={<Header counter={`(${unsolved.length})`}>{t("quests.section_unsolved")}</Header>}
      >
        {unsolved.length > 0 ? (
          <Cards<ParticipantProblemView>
            items={unsolved}
            loading={isBackend && !view && !error}
            loadingText={t("quests.loading_text")}
            cardDefinition={renderCard}
            cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
            empty={emptyUnsolved}
          />
        ) : (
          emptyUnsolved
        )}
      </Container>

      {/* Issue #1000: 解決済み section は collapsible、 初期 collapsed (= 視線を未解決に集中) */}
      <ExpandableSection
        headerText={`${t("quests.section_cleared")} (${cleared.length})`}
        variant="container"
        defaultExpanded={false}
      >
        {cleared.length > 0 ? (
          <Cards<ParticipantProblemView>
            items={cleared}
            cardDefinition={renderCard}
            cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
          />
        ) : (
          <Box textAlign="center" padding="m" color="text-status-inactive">
            {t("quests.empty_cleared")}
          </Box>
        )}
      </ExpandableSection>
    </SpaceBetween>
  );
}
