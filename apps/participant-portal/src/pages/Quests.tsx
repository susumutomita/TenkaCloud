import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Cards from "@cloudscape-design/components/cards";
import Container from "@cloudscape-design/components/container";
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
import { findProblemMetadata, type ProblemCatalogEntry } from "../data/problems";
import { useT } from "../i18n";
import { categoryOf } from "../lib/category";

/**
 * 競技者向けの 「解答状態」 (= 解けた / 解けてない)。 #821 / #822 で導入、 issue #34 で
 * 一覧カードの右上 icon に圧縮 (= ラベル無し、 視線を奪わない)。
 */
function renderSubmissionState(problem: ParticipantProblemView): {
  readonly type: StatusIndicatorProps.Type;
  readonly label: string;
} {
  if (problem.status === "FAILED") return { type: "error", label: "デプロイ失敗" };
  if (problem.status === "DELETED") return { type: "stopped", label: "終了" };
  if (problem.status === "PENDING" || problem.status === "IN_PROGRESS") {
    return { type: "in-progress", label: "準備中" };
  }
  if (problem.scoring?.kind === "flag") {
    if (problem.scoring.flagSubmitted) return { type: "success", label: "クリア" };
    return { type: "pending", label: "未解答" };
  }
  return { type: "info", label: "挑戦中" };
}

type CategoryFilter = "all" | "battle" | "challenge";
type StatusFilter = "all" | "unsolved" | "cleared";

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
const DIFFICULTY_LABEL: Record<ProblemCatalogEntry["difficulty"], string> = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
};

function difficultyBadge(problemId: string): React.ReactElement | null {
  const meta = findProblemMetadata(problemId);
  if (!meta) return null;
  return <Badge color="grey">難易度: {DIFFICULTY_LABEL[meta.difficulty]}</Badge>;
}

/**
 * issue #9: 解答状態 filter chip。 「未解答」 を default に切り替えると残タスクが俯瞰できる。
 * Challenge (flag) は flagSubmitted で判定、 Battle は採点が継続するので「未解答 / クリア済」 軸では
 * 分類困難 → "unsolved" filter のとき Battle は **常に含める** (= 取りこぼし防止)。
 */
function matchesStatusFilter(problem: ParticipantProblemView, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const submitted = problem.scoring?.kind === "flag" && problem.scoring.flagSubmitted === true;
  if (filter === "cleared") return submitted;
  // filter === "unsolved": Challenge 未提出 OR Battle (= 継続採点なので残タスク扱い)
  if (problem.scoring?.kind === "flag") return !submitted;
  return true;
}

/**
 * 自チーム向け deploy 済問題のカタログ画面 (sidebar 「問題一覧」)。Home に対する
 * compact な navigation focus 版で、各問題の status / score / アクセス先 URL を
 * カード表示する。
 *
 * データ source は `useTeamView()` (= ShellLayout 内の `/portal/me` polling 結果を共有)。
 * 専用 polling は持たない (Home / TopNav と同じ context を使う)。
 */
export function QuestsPage({ config }: { config: AppConfig }) {
  const { view, error } = useTeamView();
  const navigate = useNavigate();
  const t = useT();
  const isBackend = config.mode === "backend";
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const counts = useMemo(() => {
    const all = view?.problems ?? [];
    const unsolved = all.filter((p) => matchesStatusFilter(p, "unsolved")).length;
    const cleared = all.filter((p) => matchesStatusFilter(p, "cleared")).length;
    return {
      all: all.length,
      battle: all.filter((p) => categoryOf(p.scoring) === "battle").length,
      challenge: all.filter((p) => categoryOf(p.scoring) === "challenge").length,
      unsolved,
      cleared,
    };
  }, [view]);

  const filteredItems = useMemo(() => {
    const all = view?.problems ?? [];
    return all.filter(
      (p) =>
        (filter === "all" || categoryOf(p.scoring) === filter) &&
        matchesStatusFilter(p, statusFilter),
    );
  }, [view, filter, statusFilter]);

  const emptyMessage =
    filter === "all" && statusFilter === "all"
      ? t("quests.empty_all")
      : t("quests.empty_hint_filtered");
  const emptyHint = t("quests.empty_hint_filtered");

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("quests.header_description")}>
        {t("quests.header")}
      </Header>

      {!isBackend && <Alert type="info">{t("app.dev_mock_alert")}</Alert>}
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

      {/* issue #9: 解答状態 filter */}
      <SegmentedControl
        selectedId={statusFilter}
        onChange={({ detail }) => setStatusFilter(detail.selectedId as StatusFilter)}
        options={[
          { id: "all", text: `${t("quests.status_filter_all")} (${counts.all})` },
          { id: "unsolved", text: `${t("quests.status_filter_unsolved")} (${counts.unsolved})` },
          { id: "cleared", text: `${t("quests.status_filter_cleared")} (${counts.cleared})` },
        ]}
        label={t("quests.status_filter_label")}
      />

      <Cards<ParticipantProblemView>
        items={filteredItems}
        loading={isBackend && !view && !error}
        loadingText={t("quests.loading_text")}
        cardDefinition={{
          // jobId (ULID) を URL key にする。problemId (slug) は metadata 上 unique 前提だが、
          // 将来 problemId を意図せず重複登録された場合の link 衝突を回避する防御。
          //
          // issue #4 (audit): カードは **タイトル + 難易度 + カテゴリ + 解答状態 icon** だけ。
          // Score / Region / NamePrefix / IAM ARN / ParameterName / Console ボタン は 詳細画面に集約。
          header: (problem) => {
            const s = renderSubmissionState(problem);
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
                {difficultyBadge(problem.problemId)}
                <StatusIndicator type={s.type}>{s.label}</StatusIndicator>
              </SpaceBetween>
            );
          },
          sections: [],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
        empty={
          <Container>
            <Box textAlign="center" padding="l">
              <Box variant="strong">{emptyMessage}</Box>
              <Box variant="small" color="text-status-inactive" padding={{ top: "s" }}>
                {emptyHint}
              </Box>
            </Box>
          </Container>
        }
      />
    </SpaceBetween>
  );
}
