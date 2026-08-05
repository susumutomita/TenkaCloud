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
import { showsCourseTracks } from "../config";
import { useAppConfig, useIsMock } from "../config-context";
import { buildCourseAlignmentTracks, toProblemProgress } from "../data/course-track";
import { findProblemMetadata, listProblemCatalog } from "../data/problems";
import { useT } from "../i18n";
import { categoryOf } from "../lib/category";
import {
  gateProblemDisplayName,
  hasGateCompletionBonus,
  isGateAwaitingCompletion,
  isPrerequisiteLocked,
} from "../lib/progression";
import { CourseTrackCard } from "./CourseTracks";

/**
 * 競技者向けの 「解答状態」 (= 解けた / 解けてない)。 #821 / #822 で導入、 issue #34 で
 * 一覧カードの右上 icon に圧縮 (= ラベル無し、 視線を奪わない)。
 */
type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

interface SubmissionState {
  readonly type: StatusIndicatorProps.Type;
  readonly label: string;
}

function renderDeploymentState(
  problem: ParticipantProblemView,
  t: TFn,
): SubmissionState | undefined {
  if (problem.status === "FAILED") return { type: "error", label: t("quests.submission_failed") };
  if (problem.status === "EXPIRED") {
    return { type: "warning", label: t("quests.status_label.EXPIRED") };
  }
  if (problem.status === "DELETED" || problem.status === "AUTO_DELETED") {
    return { type: "stopped", label: t(`quests.status_label.${problem.status}`) };
  }
  if (
    problem.status === "PENDING" ||
    problem.status === "IN_PROGRESS" ||
    problem.status === "DELETING"
  ) {
    return { type: "in-progress", label: t(`quests.status_label.${problem.status}`) };
  }
  // Issue #2019: a held (APPROVAL_PENDING) deploy has no stack yet — present it as
  // in-progress (reusing the PENDING label) so it is never shown as solvable.
  if (problem.status === "APPROVAL_PENDING") {
    return { type: "in-progress", label: t("quests.status_label.PENDING") };
  }
  return undefined;
}

function renderClearedState(points: number | undefined, t: TFn): SubmissionState {
  const label =
    points !== undefined
      ? t("quests.submission_cleared_with_points", { points })
      : t("quests.submission_cleared");
  return { type: "success", label };
}

function renderMultiFlagState(scoring: ParticipantScoringInfo, t: TFn): SubmissionState {
  const flags = scoring.flags ?? [];
  const solved = flags.filter((flag) => flag.solved).length;
  if (solved === 0) {
    return { type: "pending", label: t("quests.submission_unsolved") };
  }
  if (solved === flags.length) return renderClearedState(scoring.points, t);
  return {
    type: "info",
    label: t("quests.submission_in_progress_with_count", { solved, total: flags.length }),
  };
}

/**
 * Issue #1349: 採点状態 badge を unit test 可能な pure function に分離。 各
 * problem の `status` (= deploy 進捗) と scoring の提出状態を見て、
 * 4 状態 (未着手 / Deploy 中 / 着手中 / 解答済) を返す。 解答済 (= flag 提出済) は
 * `scoring.points` があれば 「+Npt」 を末尾に付ける (= 何点 取れたかを一目で出す)。
 */
export function renderSubmissionState(problem: ParticipantProblemView, t: TFn): SubmissionState {
  const deploymentState = renderDeploymentState(problem, t);
  if (deploymentState) return deploymentState;
  if (problem.scoring?.kind === "flag") {
    if (problem.scoring.flagSubmitted) return renderClearedState(problem.scoring.points, t);
    return { type: "pending", label: t("quests.submission_unsolved") };
  }
  // Issue #2885: local container の multi-verify は participant view では multi-flag。
  // runtime が COMPLETE でも、checkpoint を 1 件も出していなければ「挑戦中」ではなく
  // 「未解答」。一部だけ解いたときに初めて進捗を表示し、全件でクリア扱いにする。
  if (problem.scoring?.kind === "multi-flag") {
    return renderMultiFlagState(problem.scoring, t);
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
/**
 * Issue #2189: the quest list card was showing the raw problem id instead of
 * its display name (the detail screen already shows the name). Falls back to
 * the id when the catalog has no metadata for it (e.g. a stale/removed problem).
 */
export function questCardTitle(problemId: string): string {
  return findProblemMetadata(problemId)?.name ?? problemId;
}

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
 * Issue #1000 / #2885: 「解決済み」 か 「未解決」 か。単一 flag は flagSubmitted、
 * multi-flag は全 checkpoint の solved で判定する。Battle は採点が継続するので
 * "unsolved" 軸に寄せる (= 取りこぼし防止、 #9 と同じ方針)。
 */
function isCleared(problem: ParticipantProblemView): boolean {
  const scoring = problem.scoring;
  if (scoring?.kind === "flag") return scoring.flagSubmitted === true;
  if (scoring?.kind === "multi-flag") {
    const flags = scoring.flags ?? [];
    return flags.length > 0 && flags.every((flag) => flag.solved);
  }
  return false;
}

/**
 * 自チーム向け deploy 済問題のカタログ画面 (sidebar 「問題一覧」)。Home に対する
 * compact な navigation focus 版で、各問題の status / score / アクセス先 URL を
 * カード表示する。
 *
 * データ source は `useTeamView()` (= ShellLayout 内の `/portal/me` 取得結果を共有)。
 * 専用 polling は持たない (Home / TopNav と同じ context を使う)。
 *
 * Issue #1000: 旧 SegmentedControl (= 全て / 未解決 / クリア) は撤去、 未解決 と 解決済み を
 * 「section 分け」 で並列表示する。 未解決 section は常時 expand、 解決済み section は
 * ExpandableSection (= 初期 collapsed)、 ひと目で残タスクと既獲得を区別できる。
 */
export function QuestsPage() {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const t = useT();
  const isMock = useIsMock();
  const config = useAppConfig();
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const allProblems = useMemo(() => view?.problems ?? [], [view]);
  const showCourseGuidance = showsCourseTracks(config.cloudMode);
  const catalog = useMemo(() => listProblemCatalog(), []);
  const courseTracks = useMemo(
    () =>
      showCourseGuidance ? buildCourseAlignmentTracks(catalog, toProblemProgress(allProblems)) : [],
    [allProblems, catalog, showCourseGuidance],
  );
  const courseProblemIds = useMemo(
    () =>
      new Set(
        courseTracks.flatMap((track) =>
          track.chapters.flatMap((chapter) => chapter.problems.map((problem) => problem.problemId)),
        ),
      ),
    [courseTracks],
  );

  // Issue #2882: local self-study では course-aligned 問題を週別 track に移す。alignment を
  // 持たない問題と catalog に無い stale problem はこの従来一覧に必ず残す。
  const catalogProblems = useMemo(
    () =>
      showCourseGuidance
        ? allProblems.filter((problem) => !courseProblemIds.has(problem.problemId))
        : allProblems,
    [allProblems, courseProblemIds, showCourseGuidance],
  );

  // Issue #2283: Progression Gate。 progression 不在 (= Gate 設定なし / feature flag OFF)
  // なら以降の badge / hint は一切出ない (= 従来表示)。
  const progression = view?.progression;
  const gateName = useMemo(
    () => gateProblemDisplayName(progression, allProblems),
    [progression, allProblems],
  );

  const counts = useMemo(() => {
    return {
      all: catalogProblems.length,
      battle: catalogProblems.filter((p) => categoryOf(p.scoring) === "battle").length,
      challenge: catalogProblems.filter((p) => categoryOf(p.scoring) === "challenge").length,
    };
  }, [catalogProblems]);

  const categoryFiltered = useMemo(() => {
    return catalogProblems.filter((p) => filter === "all" || categoryOf(p.scoring) === filter);
  }, [catalogProblems, filter]);

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
        // Issue #2283: Progression Gate の出し分け。 locked 問題は隠さず「ロック中」 badge +
        // 解放条件を出し、 Gate 問題 (未完了時) には 「最初にここから」 を目立たせる。
        // policy "off" の team (= locked 無し) には解放約束 badge を出さないが、 完了 bonus
        // badge は locked の有無と無関係に出す (hasGateCompletionBonus)。
        const locked = isPrerequisiteLocked(progression, problem.problemId);
        const gatePending = isGateAwaitingCompletion(progression, problem.problemId);
        const bonusPending = hasGateCompletionBonus(progression, problem.problemId);
        return (
          <SpaceBetween size="xxs">
            <SpaceBetween size="xs" direction="horizontal" alignItems="center">
              <Link
                fontSize="heading-m"
                href={`/problems/${encodeURIComponent(problem.jobId)}`}
                onFollow={(e) => {
                  e.preventDefault();
                  navigate(`/problems/${encodeURIComponent(problem.jobId)}`);
                }}
              >
                {questCardTitle(problem.problemId)}
              </Link>
              {/* [#2696 PR5] local play's one fixed container intro drill:
               * the backend pins it first in the catalog and flags it `recommended`. */}
              {problem.recommended && (
                <Badge color="green">{t("quests.recommended_start_here")}</Badge>
              )}
              {categoryBadge(problem.scoring, t("quests.category_uncategorized"))}
              {difficultyBadge(problem.problemId, t)}
              {gatePending && <Badge color="green">{t("quests.gate_start_here")}</Badge>}
              {bonusPending && progression && (
                <Badge color="blue">
                  {t("quests.gate_completion_bonus", { points: progression.completionBonus })}
                </Badge>
              )}
              {locked && <Badge color="grey">{t("quests.locked_badge")}</Badge>}
              <StatusIndicator type={s.type}>{s.label}</StatusIndicator>
            </SpaceBetween>
            {locked && (
              <Box variant="small" color="text-status-inactive">
                {t("quests.locked_unlock_condition", { gateName })}
              </Box>
            )}
          </SpaceBetween>
        );
      },
      sections: [],
    }),
    [navigate, t, progression, gateName],
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

      {courseTracks.length > 0 ? (
        <SpaceBetween size="m" data-testid="course-guidance">
          <Header variant="h2" description={t("quests.course_guidance_description")}>
            {t("quests.course_guidance_header")}
          </Header>
          {courseTracks.map((track) => (
            <CourseTrackCard
              key={track.trackId}
              track={track}
              onOpen={(problemId) => {
                const deployed = allProblems.find((problem) => problem.problemId === problemId);
                navigate(
                  deployed ? `/problems/${encodeURIComponent(deployed.jobId)}` : "/problems",
                );
              }}
              t={t}
            />
          ))}
        </SpaceBetween>
      ) : null}

      {courseTracks.length > 0 ? (
        <Header variant="h2" description={t("quests.other_problems_description")}>
          {t("quests.other_problems_header")}
        </Header>
      ) : null}

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

      {/* Issue #1000: 未解決 section を常時 expand で先頭に並べる。 Cards 自身の
       *   loading / empty slot に委ねる (= 旧 ternary は loading 中も emptyUnsolved を
       *   出してしまい spinner が死んでいた)。 */}
      <Container
        header={<Header counter={`(${unsolved.length})`}>{t("quests.section_unsolved")}</Header>}
      >
        <Cards<ParticipantProblemView>
          items={unsolved}
          loading={!isMock && !view && !error}
          loadingText={t("quests.loading_text")}
          cardDefinition={renderCard}
          cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
          empty={emptyUnsolved}
        />
      </Container>

      {/* Issue #1000: 解決済み section は collapsible、 初期 collapsed (= 視線を未解決に集中) */}
      <ExpandableSection
        headerText={`${t("quests.section_cleared")} (${cleared.length})`}
        variant="container"
        defaultExpanded={false}
      >
        <Cards<ParticipantProblemView>
          items={cleared}
          cardDefinition={renderCard}
          cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
          empty={
            <Box textAlign="center" padding="m" color="text-status-inactive">
              {t("quests.empty_cleared")}
            </Box>
          }
        />
      </ExpandableSection>
    </SpaceBetween>
  );
}
