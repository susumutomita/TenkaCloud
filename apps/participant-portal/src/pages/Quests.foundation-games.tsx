import type { LocaleCode } from "../i18n";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";
import type { QuestFilterState } from "./Quests.filters";

export type BrowserGameId = "mail-detective" | "cloud-master";
/** Display-only entries: never added to an event, API response, or scoring catalog. */
export interface BrowserProblem {
  readonly browserGame: BrowserGameId;
  readonly name: string;
  readonly href: string;
  readonly searchText: string;
  readonly difficulty: 1;
}
export function foundationGameHref(base: string, game: BrowserGameId, locale: LocaleCode): string {
  const target = new URL(`../${game}/`, new URL(base, "https://preview.invalid"));
  return `${target.pathname}?lang=${locale}`;
}
export function browserProblems(base: string, locale: LocaleCode): BrowserProblem[] {
  return (["mail-detective", "cloud-master"] as const).map((browserGame) => ({
    browserGame,
    name: (locale === "en" ? en : ja).foundation_games[browserGame].title,
    href: foundationGameHref(base, browserGame, locale),
    searchText: [
      browserGame,
      ja.foundation_games[browserGame].title,
      en.foundation_games[browserGame].title,
      ja.foundation_games[browserGame].description,
      en.foundation_games[browserGame].description,
      "browser ブラウザ",
    ]
      .join("\n")
      .toLocaleLowerCase(),
    difficulty: 1,
  }));
}
export function filterBrowserProblems(
  problems: readonly BrowserProblem[],
  filters: QuestFilterState,
): BrowserProblem[] {
  return problems.filter(
    (problem) =>
      (filters.category === "all" || filters.category === "challenge") &&
      (filters.difficulty === "all" || filters.difficulty === problem.difficulty) &&
      // No cross-game completion is recorded. Never claim a saved cleared/in-progress state.
      (filters.answerStatus === "all" || filters.answerStatus === "unsolved") &&
      problem.searchText.includes(filters.query.trim().toLocaleLowerCase()),
  );
}
