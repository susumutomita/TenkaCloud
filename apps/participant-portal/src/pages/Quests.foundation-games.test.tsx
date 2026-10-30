import { describe, expect, it } from "vitest";
import type { QuestFilterState } from "./Quests.filters";
import {
  browserProblems,
  filterBrowserProblems,
  foundationGameHref,
} from "./Quests.foundation-games";

const defaults: QuestFilterState = {
  category: "all",
  query: "",
  difficulty: "all",
  answerStatus: "all",
};
describe("browser entries in the shared problem list", () => {
  it.each(["ja", "en"] as const)(
    "has only two display entries with direct locale-safe links in %s",
    (lang) => {
      const entries = browserProblems("/portal-demo/", lang);
      expect(entries).toHaveLength(2);
      expect(entries.map((x) => x.href)).toEqual([
        `/mail-detective/?lang=${lang}`,
        `/cloud-master/?lang=${lang}`,
      ]);
      expect(filterBrowserProblems(entries, defaults)).toEqual(entries);
    },
  );
  it("preserves deployment prefixes", () =>
    expect(foundationGameHref("/TenkaCloud/portal-demo/", "cloud-master", "en")).toBe(
      "/TenkaCloud/cloud-master/?lang=en",
    ));
  it.each(["ja", "en"] as const)(
    "searches titles and descriptions in both languages in %s",
    (lang) => {
      const entries = browserProblems("/portal-demo/", lang);
      for (const query of ["メール", " EMAIL ", "危険につながる"])
        expect(
          filterBrowserProblems(entries, { ...defaults, query }).map((x) => x.browserGame),
        ).toEqual(["mail-detective"]);
      for (const query of ["Cloud Master", "不審なAPI"])
        expect(
          filterBrowserProblems(entries, { ...defaults, query }).map((x) => x.browserGame),
        ).toEqual(["cloud-master"]);
      expect(filterBrowserProblems(entries, { ...defaults, query: "no-such-problem" })).toEqual([]);
    },
  );
  it("applies category, difficulty and answer-state AND filters without inventing recorded results", () => {
    const entries = browserProblems("/portal-demo/", "ja");
    expect(filterBrowserProblems(entries, { ...defaults, category: "battle" })).toEqual([]);
    expect(
      filterBrowserProblems(entries, {
        ...defaults,
        category: "challenge",
        difficulty: 1,
        answerStatus: "unsolved",
      }),
    ).toHaveLength(2);
    expect(filterBrowserProblems(entries, { ...defaults, difficulty: 2 })).toEqual([]);
    expect(filterBrowserProblems(entries, { ...defaults, answerStatus: "cleared" })).toEqual([]);
    expect(filterBrowserProblems(entries, { ...defaults, answerStatus: "in-progress" })).toEqual(
      [],
    );
    expect(
      filterBrowserProblems(entries, { ...defaults, query: "email", category: "battle" }),
    ).toEqual([]);
  });
});
