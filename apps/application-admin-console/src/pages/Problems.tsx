import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Cards from "@cloudscape-design/components/cards";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import SegmentedControl, {
  type SegmentedControlProps,
} from "@cloudscape-design/components/segmented-control";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listProblemSummaries, type ProblemSummary } from "../data/problems";
import {
  collectTagFacets,
  type DifficultyLevel,
  EMPTY_FILTER_CRITERIA,
  filterProblems,
  isFilterActive,
  type ProblemFilterCriteria,
  toggleTagFilter,
} from "../lib/problem-filter";

const DIFFICULTY_LABEL: Record<ProblemSummary["difficulty"], string> = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
};

const STATUS_BADGE_COLOR: Record<ProblemSummary["status"], "green" | "blue" | "grey"> = {
  ready: "green",
  draft: "blue",
  deprecated: "grey",
};

const STATUS_LABEL: Record<ProblemSummary["status"], string> = {
  ready: "公開中",
  draft: "下書き",
  deprecated: "停止予定",
};

const CATEGORY_SEGMENTS: SegmentedControlProps.Option[] = [
  { id: "all", text: "全て" },
  { id: "Battle", text: "Battle" },
  { id: "Challenge", text: "Challenge" },
];

const STATUS_SEGMENTS: SegmentedControlProps.Option[] = [
  { id: "all", text: "全て" },
  { id: "ready", text: "公開中" },
  { id: "draft", text: "下書き" },
  { id: "deprecated", text: "停止予定" },
];

const DIFFICULTY_LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5];

/**
 * 問題一覧ページ。Cloudscape Cards で 1 件ずつカード表示する。
 * クリックすると /problems/:id へ遷移して詳細 + Deploy ボタン。
 *
 * Issue #834 / #835: 検索 box / category / status / 難易度 / タグ filter を提供。
 * tag badge は click で 「そのタグだけで絞り込み」 (= toggle、 同タグ 2 回 click で解除)。
 */
export function ProblemsPage() {
  const navigate = useNavigate();
  const problems = listProblemSummaries();
  const [criteria, setCriteria] = useState<ProblemFilterCriteria>(EMPTY_FILTER_CRITERIA);

  const filtered = useMemo(() => filterProblems(problems, criteria), [problems, criteria]);
  const tagFacets = useMemo(() => collectTagFacets(problems), [problems]);
  const tagOptions: MultiselectProps.Option[] = useMemo(
    () => tagFacets.map((f) => ({ value: f.tag, label: f.tag, description: `${f.count} 件` })),
    [tagFacets],
  );
  const tagSelected: MultiselectProps.Option[] = useMemo(
    () => criteria.tags.map((t) => ({ value: t, label: t })),
    [criteria.tags],
  );
  const difficultyOptions: MultiselectProps.Option[] = useMemo(
    () =>
      DIFFICULTY_LEVELS.map((d) => ({
        value: String(d),
        label: `${d} (${DIFFICULTY_LABEL[d]})`,
      })),
    [],
  );
  const difficultySelected: MultiselectProps.Option[] = useMemo(
    () => criteria.difficulties.map((d) => ({ value: String(d), label: `${d}` })),
    [criteria.difficulties],
  );

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="競技アカウントへデプロイ可能な問題の一覧。 検索 / カテゴリ / 状態 / 難易度 / タグで絞り込みできます。"
        counter={
          isFilterActive(criteria)
            ? `(${filtered.length} / ${problems.length})`
            : `(${problems.length})`
        }
        actions={
          isFilterActive(criteria) && (
            <Button onClick={() => setCriteria(EMPTY_FILTER_CRITERIA)}>絞り込み解除</Button>
          )
        }
      >
        問題カタログ
      </Header>

      <SpaceBetween size="s">
        <Input
          type="search"
          value={criteria.search}
          placeholder="問題名 / 説明 / タグから検索 (substring, 大文字小文字無視)"
          onChange={({ detail }) => setCriteria((prev) => ({ ...prev, search: detail.value }))}
        />
        <SpaceBetween direction="horizontal" size="s">
          <SegmentedControl
            selectedId={criteria.categories.length === 1 ? criteria.categories[0] : "all"}
            options={CATEGORY_SEGMENTS}
            label="カテゴリ"
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                categories:
                  detail.selectedId === "all"
                    ? []
                    : [detail.selectedId as ProblemSummary["category"]],
              }))
            }
          />
          <SegmentedControl
            selectedId={criteria.statuses.length === 1 ? criteria.statuses[0] : "all"}
            options={STATUS_SEGMENTS}
            label="公開状態"
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                statuses:
                  detail.selectedId === "all"
                    ? []
                    : [detail.selectedId as ProblemSummary["status"]],
              }))
            }
          />
        </SpaceBetween>
        <SpaceBetween direction="horizontal" size="s">
          <Multiselect
            placeholder="難易度を選択"
            options={difficultyOptions}
            selectedOptions={difficultySelected}
            tokenLimit={5}
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                difficulties: detail.selectedOptions
                  .map((o) => Number(o.value))
                  .filter((n): n is DifficultyLevel =>
                    DIFFICULTY_LEVELS.includes(n as DifficultyLevel),
                  ),
              }))
            }
          />
          <Multiselect
            placeholder={`タグを選択 (${criteria.tagMatchMode === "and" ? "全て含む" : "いずれか含む"})`}
            options={tagOptions}
            selectedOptions={tagSelected}
            tokenLimit={10}
            onChange={({ detail }) =>
              setCriteria((prev) => ({
                ...prev,
                tags: detail.selectedOptions
                  .map((o) => o.value)
                  .filter((v): v is string => typeof v === "string"),
              }))
            }
          />
          {criteria.tags.length > 1 && (
            <Button
              onClick={() =>
                setCriteria((prev) => ({
                  ...prev,
                  tagMatchMode: prev.tagMatchMode === "and" ? "or" : "and",
                }))
              }
            >
              タグ結合: {criteria.tagMatchMode === "and" ? "AND (全て含む)" : "OR (いずれか含む)"}
            </Button>
          )}
        </SpaceBetween>
      </SpaceBetween>

      <Cards
        items={[...filtered]}
        cardDefinition={{
          header: (item) => (
            <Link
              fontSize="heading-m"
              onFollow={(e) => {
                e.preventDefault();
                navigate(`/problems/${encodeURIComponent(item.id)}`);
              }}
              href={`/problems/${encodeURIComponent(item.id)}`}
            >
              {item.name}
            </Link>
          ),
          sections: [
            {
              id: "badges",
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Badge color={item.category === "Battle" ? "red" : "blue"}>{item.category}</Badge>
                  <Badge color={STATUS_BADGE_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                  <Badge color="grey">難易度: {DIFFICULTY_LABEL[item.difficulty]}</Badge>
                  <Badge color="grey">想定時間: {item.estimatedDuration}</Badge>
                </SpaceBetween>
              ),
            },
            {
              id: "description",
              content: (item) => <Box variant="p">{item.shortDescription}</Box>,
            },
            {
              id: "tags",
              header: "タグ",
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xxs">
                  {item.tags.map((tag) => {
                    const isActive = criteria.tags.includes(tag);
                    return (
                      <Button
                        key={tag}
                        variant={isActive ? "primary" : "inline-link"}
                        onClick={() => setCriteria((prev) => toggleTagFilter(prev, tag))}
                        ariaLabel={
                          isActive ? `タグ ${tag} の絞り込みを解除` : `タグ ${tag} で絞り込む`
                        }
                      >
                        {tag}
                      </Button>
                    );
                  })}
                </SpaceBetween>
              ),
            },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }]}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {isFilterActive(criteria) ? (
              <SpaceBetween size="s">
                <Box variant="p">条件に一致する問題はありません。</Box>
                <Button onClick={() => setCriteria(EMPTY_FILTER_CRITERIA)}>絞り込み解除</Button>
              </SpaceBetween>
            ) : (
              "問題がまだ登録されていません。"
            )}
          </Box>
        }
      />
    </SpaceBetween>
  );
}
