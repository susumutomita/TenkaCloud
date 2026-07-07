import { describe, expect, it } from "vitest";
import type { CatalogProblem } from "@/content/catalog-data";
import {
  CATEGORY_LABEL,
  catalogCounts,
  difficultyLabel,
  groupedCatalog,
  STATUS_LABEL,
} from "./catalog";

function problem(overrides: Partial<CatalogProblem>): CatalogProblem {
  return {
    id: "x",
    category: "Challenge",
    status: "ready",
    difficulty: 1,
    tags: [],
    name: { ja: "x", en: "x" },
    ...overrides,
  };
}

describe("catalogCounts", () => {
  it("should count total and ready-by-category, ignoring drafts in the ready split", () => {
    const problems: CatalogProblem[] = [
      problem({ id: "b1", category: "Battle", status: "ready" }),
      problem({ id: "b2", category: "Battle", status: "draft" }),
      problem({ id: "c1", category: "Challenge", status: "ready" }),
      problem({ id: "c2", category: "Challenge", status: "ready" }),
      problem({ id: "c3", category: "Challenge", status: "draft" }),
    ];
    const counts = catalogCounts(problems);
    expect(counts.total).toBe(5);
    expect(counts.ready).toBe(3);
    expect(counts.readyBattle).toBe(1);
    expect(counts.readyChallenge).toBe(2);
  });
});

describe("groupedCatalog", () => {
  it("should group Battle before Challenge and drop empty categories", () => {
    const problems: CatalogProblem[] = [
      problem({ id: "c1", category: "Challenge" }),
      problem({ id: "b1", category: "Battle" }),
    ];
    const groups = groupedCatalog(problems);
    expect(groups.map((group) => group.category)).toEqual(["Battle", "Challenge"]);

    const onlyChallenge = groupedCatalog([problem({ id: "c1", category: "Challenge" })]);
    expect(onlyChallenge.map((group) => group.category)).toEqual(["Challenge"]);
  });
});

describe("difficultyLabel", () => {
  it("should map 1..5 to a level name and clamp out-of-range values", () => {
    expect(difficultyLabel("ja", 1)).toBe("入門");
    expect(difficultyLabel("en", 5)).toBe("Expert");
    expect(difficultyLabel("en", 0)).toBe("Intro");
    expect(difficultyLabel("en", 9)).toBe("Expert");
  });
});

describe("label maps", () => {
  it("should provide both locales for category and status", () => {
    expect(CATEGORY_LABEL.ja.Battle).toContain("Battle");
    expect(CATEGORY_LABEL.en.Challenge).toBe("Challenge");
    expect(STATUS_LABEL.ja.ready).toBe("公開中");
    expect(STATUS_LABEL.en.draft).toBe("In development");
  });
});
