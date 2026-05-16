import type { ProblemCategory, ProblemStatus, ProblemSummary } from "../data/problems";

/**
 * Issue #834 / #835: 問題カタログ page の filter / search を pure logic 化。
 *
 * 設計指針:
 *  - **pure function**: side-effect なし。 React state 側で memoize して使う。
 *  - **union semantic**: 各 filter (search / category / status / difficulty / tag) は **AND**。
 *    tag だけ 「複数 tag 選択時に OR vs AND」 を caller が選べるよう `tagMatchMode` を取る。
 *  - **search**: `name` / `shortDescription` / `tags` (kebab-case の文字列) を **substring** で
 *    case-insensitive に走査。 旧 catalog の 4 問題程度なら正規表現は使わない (= 過剰)。
 */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;
export type TagMatchMode = "or" | "and";

export interface ProblemFilterCriteria {
  /** 全文検索 (= name / shortDescription / tags を substring match)。 空文字 = no-op。 */
  readonly search: string;
  /** カテゴリ filter。 空配列 = 全カテゴリ表示。 */
  readonly categories: readonly ProblemCategory[];
  /** 公開状態 filter。 空配列 = 全状態表示。 */
  readonly statuses: readonly ProblemStatus[];
  /** 難易度 multi-select。 空配列 = 全難易度表示。 */
  readonly difficulties: readonly DifficultyLevel[];
  /** タグ multi-select。 空配列 = タグ filter なし。 */
  readonly tags: readonly string[];
  /** タグが複数選択されたときの結合 (default OR、 "absolutely include" は AND)。 */
  readonly tagMatchMode: TagMatchMode;
}

export const EMPTY_FILTER_CRITERIA: ProblemFilterCriteria = {
  search: "",
  categories: [],
  statuses: [],
  difficulties: [],
  tags: [],
  tagMatchMode: "or",
};

export function isFilterActive(c: ProblemFilterCriteria): boolean {
  return (
    c.search.trim().length > 0 ||
    c.categories.length > 0 ||
    c.statuses.length > 0 ||
    c.difficulties.length > 0 ||
    c.tags.length > 0
  );
}

function matchesSearch(problem: ProblemSummary, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [problem.name, problem.shortDescription, ...problem.tags]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesTags(
  problemTags: readonly string[],
  selectedTags: readonly string[],
  mode: TagMatchMode,
): boolean {
  if (selectedTags.length === 0) return true;
  if (mode === "and") return selectedTags.every((t) => problemTags.includes(t));
  return selectedTags.some((t) => problemTags.includes(t));
}

export function filterProblems(
  problems: readonly ProblemSummary[],
  criteria: ProblemFilterCriteria,
): readonly ProblemSummary[] {
  const needle = criteria.search.trim().toLowerCase();
  return problems.filter((p) => {
    if (!matchesSearch(p, needle)) return false;
    if (criteria.categories.length > 0 && !criteria.categories.includes(p.category)) return false;
    if (criteria.statuses.length > 0 && !criteria.statuses.includes(p.status)) return false;
    if (criteria.difficulties.length > 0 && !criteria.difficulties.includes(p.difficulty)) {
      return false;
    }
    if (!matchesTags(p.tags, criteria.tags, criteria.tagMatchMode)) return false;
    return true;
  });
}

/**
 * カタログ全体から union された tag 一覧を返す (= multi-select 候補 + count badge)。
 * 出現頻度の降順 → タイ時は alphabetical で安定 sort。
 */
export function collectTagFacets(
  problems: readonly ProblemSummary[],
): readonly { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of problems) {
    for (const tag of p.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Issue #835: 1 タグ click → そのタグだけ active な criteria を作る。
 * 既に同じタグ 1 件のみ active なら 「 clear 」 とみなして空に戻す (= toggle)。
 */
export function toggleTagFilter(
  criteria: ProblemFilterCriteria,
  tag: string,
): ProblemFilterCriteria {
  const isOnlyThisTag = criteria.tags.length === 1 && criteria.tags[0] === tag;
  if (isOnlyThisTag) return { ...criteria, tags: [] };
  // 単 click は「そのタグだけで絞り込み」 (= filter 全面切替)。
  // 累積 add したいケースは header の multi-select UI を使う想定。
  return { ...criteria, tags: [tag] };
}
