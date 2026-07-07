import {
  CATALOG_DATA,
  type CatalogCategory,
  type CatalogProblem,
  type CatalogStatus,
} from "@/content/catalog-data";
import type { Locale } from "@/lib/i18n";

// Display helpers for the public catalog. The catalog DATA is generated from the
// problems/ submodule (source of truth); everything here is presentation-only and
// fully bilingual so the /catalog and /en/catalog pages read the same.

export const CATEGORY_LABEL: Record<Locale, Record<CatalogCategory, string>> = {
  ja: { Battle: "Battle（対戦）", Challenge: "Challenge（演習）" },
  en: { Battle: "Battle", Challenge: "Challenge" },
};

// `ready` problems are playable today; `draft` problems are being prepared and are
// deliberately NOT presented as live (product rule: no unverified feature is
// advertised as available).
export const STATUS_LABEL: Record<Locale, Record<CatalogStatus, string>> = {
  ja: { ready: "公開中", draft: "準備中", deprecated: "提供終了" },
  en: { ready: "Available", draft: "In development", deprecated: "Retired" },
};

// difficulty 1..5 → a human level name (index 0 == difficulty 1).
const DIFFICULTY_LABELS: Record<Locale, readonly string[]> = {
  ja: ["入門", "初級", "中級", "上級", "エキスパート"],
  en: ["Intro", "Beginner", "Intermediate", "Advanced", "Expert"],
};

export function difficultyLabel(locale: Locale, difficulty: number): string {
  const index = Math.min(5, Math.max(1, Math.round(difficulty))) - 1;
  return DIFFICULTY_LABELS[locale][index];
}

export interface CategoryGroup {
  readonly category: CatalogCategory;
  readonly problems: readonly CatalogProblem[];
}

// The catalog grouped by category, preserving the generated (deterministic) order.
export function groupedCatalog(
  problems: readonly CatalogProblem[] = CATALOG_DATA.problems,
): readonly CategoryGroup[] {
  const order: readonly CatalogCategory[] = ["Battle", "Challenge"];
  return order
    .map((category) => ({
      category,
      problems: problems.filter((problem) => problem.category === category),
    }))
    .filter((group) => group.problems.length > 0);
}

export interface CatalogCounts {
  readonly total: number;
  readonly ready: number;
  readonly readyBattle: number;
  readonly readyChallenge: number;
}

// Counts used by the home-page catalog teaser. Only `ready` problems are counted as
// "playable now"; draft counts are kept separate so the copy never overstates.
export function catalogCounts(
  problems: readonly CatalogProblem[] = CATALOG_DATA.problems,
): CatalogCounts {
  const ready = problems.filter((problem) => problem.status === "ready");
  return {
    total: problems.length,
    ready: ready.length,
    readyBattle: ready.filter((problem) => problem.category === "Battle").length,
    readyChallenge: ready.filter((problem) => problem.category === "Challenge").length,
  };
}
