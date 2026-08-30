import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Cards from "@cloudscape-design/components/cards";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SegmentedControl from "@cloudscape-design/components/segmented-control";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import TextFilter from "@cloudscape-design/components/text-filter";
import Toggle from "@cloudscape-design/components/toggle";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { ParticipantProblemView } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import { hasSolvedAnyProblem } from "../components/NextActionHero";
import { showsCourseTracks } from "../config";
import { useAppConfig, useIsMock } from "../config-context";
import {
  buildCourseAlignmentTracks,
  recommendedNextAcrossTracks,
  toProblemProgress,
} from "../data/course-track";
import { listProblemCatalog } from "../data/problems";
import { useI18n, useT } from "../i18n";
import { categoryOf } from "../lib/category";
import {
  hidesDraftProblems,
  readShowDraftProblems,
  visibleCatalogEntries,
  visibleQuestProblems,
  writeShowDraftProblems,
} from "../lib/draft-visibility";
import {
  gateProblemDisplayName,
  hasGateCompletionBonus,
  isGateAwaitingCompletion,
  isPrerequisiteLocked,
} from "../lib/progression";
import { awsOnlyBadge, categoryBadge, difficultyBadge, questCardTitle } from "./Quests.badges";
import {
  filterQuestProblems,
  isQuestCleared,
  type QuestAnswerStatusFilter,
  type QuestCategoryFilter,
  type QuestDifficultyFilter,
  type QuestSearchMetadata,
} from "./Quests.filters";
import { LocalStartGuidance } from "./Quests.local-start";
import { renderSubmissionState } from "./Quests.submission-state";

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
  const { locale } = useI18n();
  const isMock = useIsMock();
  const config = useAppConfig();
  const [filter, setFilter] = useState<QuestCategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<QuestDifficultyFilter>("all");
  const [answerStatus, setAnswerStatus] = useState<QuestAnswerStatusFilter>("all");
  // draft 表示は開発者向けの opt-in。既定は隠す (通常プレーで未完成問題を起動させない)。
  const [showDrafts, setShowDrafts] = useState(() => readShowDraftProblems());
  // 隠す規則が成立するのは一覧 = catalog 全件の local だけ。cloud mode では toggle 自体を出さない
  // (何も隠れないので効き目のない開発者向けスイッチになる)。
  const canHideDrafts = hidesDraftProblems(config.cloudMode);

  const allProblems = useMemo(() => view?.problems ?? [], [view]);
  const showCourseGuidance = showsCourseTracks(config.cloudMode);
  const catalog = useMemo(() => listProblemCatalog(), []);
  const metadataByProblemId = useMemo<ReadonlyMap<string, QuestSearchMetadata>>(
    () => new Map(catalog.map((metadata) => [metadata.id, metadata])),
    [catalog],
  );
  // draft を隠した後の母集合。進行中 / 起動済み / pin された入門ドリルの draft は残る
  // (lib/draft-visibility.ts の不変条件)。以降の一覧・件数・講座 track はこちらから作る。
  const visibleProblems = useMemo(
    () =>
      visibleQuestProblems(
        allProblems,
        (problemId) => metadataByProblemId.get(problemId)?.status,
        showDrafts,
        config.cloudMode,
      ),
    [allProblems, config.cloudMode, metadataByProblemId, showDrafts],
  );
  const hiddenDraftCount = allProblems.length - visibleProblems.length;
  const visibleCatalog = useMemo(
    () => visibleCatalogEntries(catalog, allProblems, showDrafts),
    [allProblems, catalog, showDrafts],
  );
  const courseTracks = useMemo(
    () =>
      showCourseGuidance
        ? buildCourseAlignmentTracks(visibleCatalog, toProblemProgress(visibleProblems))
        : [],
    [visibleProblems, visibleCatalog, showCourseGuidance],
  );
  // [Issue #2965] Home と同じ選択規則を使う。先頭を取ると track id の辞書順で「どの講座を
  // 勧めるか」が決まり、2 つの画面が別々の基準で別々の答えを出す状態になる。
  const recommendedCourseProblem = recommendedNextAcrossTracks(courseTracks);
  const recommendedCourseJobId = recommendedCourseProblem
    ? allProblems.find((problem) => problem.problemId === recommendedCourseProblem.problemId)?.jobId
    : undefined;
  // [#2928] 「初めてなら」 の送り先。 唯一の講座トラックは大学院レベルの暗号講座なので、
  // 初見の人をそこへ送るのは案内として逆だった。 まだ 1 問も解いていない人には、 platform が
  // pin した入門ドリル (`recommended: true`) を主導線に置き、 講座トラックは併記に下げる。
  // 1 問でも解けば従来の案内へ戻る (= 講座を進めている人の導線を変えない)。
  const introProblem = useMemo(
    () =>
      hasSolvedAnyProblem(allProblems)
        ? undefined
        : allProblems.find((problem) => problem.recommended === true),
    [allProblems],
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
        ? visibleProblems.filter((problem) => !courseProblemIds.has(problem.problemId))
        : visibleProblems,
    [visibleProblems, courseProblemIds, showCourseGuidance],
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

  const filteredProblems = useMemo(
    () =>
      filterQuestProblems(
        catalogProblems,
        { category: filter, query, difficulty, answerStatus },
        metadataByProblemId,
      ),
    [answerStatus, catalogProblems, difficulty, filter, metadataByProblemId, query],
  );
  const hasActiveFilters =
    filter !== "all" || query.trim().length > 0 || difficulty !== "all" || answerStatus !== "all";

  const { unsolved, cleared } = useMemo(() => {
    const u: ParticipantProblemView[] = [];
    const c: ParticipantProblemView[] = [];
    for (const p of filteredProblems) {
      if (isQuestCleared(p)) c.push(p);
      else u.push(p);
    }
    return { unsolved: u, cleared: c };
  }, [filteredProblems]);

  const difficultyOptions = [
    { value: "all", label: t("quests.difficulty_filter_all") },
    ...([1, 2, 3, 4, 5] as const).map((value) => ({
      value: String(value),
      label: t(`quests.difficulty_${value}`),
    })),
  ];
  const difficultyLabels: Record<QuestDifficultyFilter, string> = {
    all: t("quests.difficulty_filter_all"),
    1: t("quests.difficulty_1"),
    2: t("quests.difficulty_2"),
    3: t("quests.difficulty_3"),
    4: t("quests.difficulty_4"),
    5: t("quests.difficulty_5"),
  };
  const answerStatusOptions = [
    { value: "all", label: t("quests.answer_status_filter_all") },
    { value: "unsolved", label: t("quests.submission_unsolved") },
    { value: "in-progress", label: t("quests.submission_in_progress") },
    { value: "cleared", label: t("quests.submission_cleared") },
  ];
  const answerStatusLabels: Record<QuestAnswerStatusFilter, string> = {
    all: t("quests.answer_status_filter_all"),
    unsolved: t("quests.submission_unsolved"),
    "in-progress": t("quests.submission_in_progress"),
    cleared: t("quests.submission_cleared"),
  };

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
              {awsOnlyBadge(problem.problemId, t)}
              {/* 開発者が toggle で表示した draft を見分ける印。exempt (進行中等) の draft にも付く。 */}
              {metadataByProblemId.get(problem.problemId)?.status === "draft" && (
                <Badge color="grey">{t("quests.draft_badge")}</Badge>
              )}
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
    [navigate, t, progression, gateName, metadataByProblemId],
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

      {/* 学習ルートそのものはここに出さない — 置き場は `/course-tracks`。#2898 では local の
       * 初見参加者が「講座」と「その他」のどちらを選ぶか判断でき、推奨 1 問へ 1 click で
       * 到達できる案内だけを置く。一覧を週別 track で再び埋めない。 */}
      {courseTracks.length > 0 ? (
        <SpaceBetween size="l">
          <LocalStartGuidance
            t={t}
            navigate={navigate}
            introProblem={introProblem}
            courseProblemName={recommendedCourseProblem?.name}
            courseJobId={recommendedCourseJobId}
            locale={locale}
          />

          <Header variant="h2" description={t("quests.other_problems_description")}>
            {t("quests.other_problems_header")}
          </Header>
        </SpaceBetween>
      ) : null}

      <SpaceBetween size="s">
        <SegmentedControl
          selectedId={filter}
          onChange={({ detail }) => setFilter(detail.selectedId as QuestCategoryFilter)}
          options={[
            { id: "all", text: `${t("quests.filter_all")} (${counts.all})` },
            { id: "battle", text: `${t("quests.filter_battle")} (${counts.battle})` },
            { id: "challenge", text: `${t("quests.filter_challenge")} (${counts.challenge})` },
          ]}
          label={t("quests.filter_label")}
        />
        <TextFilter
          filteringText={query}
          onChange={({ detail }) => setQuery(detail.filteringText)}
          filteringAriaLabel={t("quests.search_label")}
          filteringPlaceholder={t("quests.search_placeholder")}
          countText={t("quests.filter_results", { count: filteredProblems.length })}
        />
        <ColumnLayout columns={2}>
          <Select
            ariaLabel={t("quests.difficulty_filter_label")}
            selectedOption={{ value: String(difficulty), label: difficultyLabels[difficulty] }}
            options={difficultyOptions}
            onChange={({ detail }) => {
              const value = detail.selectedOption.value;
              setDifficulty(
                value === "all" ? "all" : (Number(value) as Exclude<QuestDifficultyFilter, "all">),
              );
            }}
          />
          <Select
            ariaLabel={t("quests.answer_status_filter_label")}
            selectedOption={{ value: answerStatus, label: answerStatusLabels[answerStatus] }}
            options={answerStatusOptions}
            onChange={({ detail }) =>
              setAnswerStatus(detail.selectedOption.value as QuestAnswerStatusFilter)
            }
          />
        </ColumnLayout>
        {canHideDrafts && (
          <SpaceBetween size="xs" direction="horizontal" alignItems="center">
            <Toggle
              checked={showDrafts}
              onChange={({ detail }) => {
                setShowDrafts(detail.checked);
                writeShowDraftProblems(detail.checked);
              }}
            >
              {t("quests.show_drafts_label")}
            </Toggle>
            {!showDrafts && hiddenDraftCount > 0 && (
              <Box variant="small" color="text-status-inactive">
                {t("quests.drafts_hidden_hint", { count: hiddenDraftCount })}
              </Box>
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>

      {view && hasActiveFilters && filteredProblems.length === 0 ? (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">{t("quests.filter_empty_header")}</Box>
            <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
              {t("quests.filter_empty_body")}
            </Box>
          </Box>
        </Container>
      ) : (
        <>
          {/* Issue #1000: 未解決 section を常時 expand で先頭に並べる。 Cards 自身の
           *   loading / empty slot に委ねる (= 旧 ternary は loading 中も emptyUnsolved を
           *   出してしまい spinner が死んでいた)。 */}
          <Container
            header={
              <Header counter={`(${unsolved.length})`}>{t("quests.section_unsolved")}</Header>
            }
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
        </>
      )}
    </SpaceBetween>
  );
}
