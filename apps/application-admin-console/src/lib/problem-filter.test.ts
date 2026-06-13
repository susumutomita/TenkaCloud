import { describe, expect, it } from "vitest";
import type { ProblemSummary } from "../data/problems";
import {
  collectScoringKindFacets,
  collectTagFacets,
  DIFFICULTY_LEVELS,
  EMPTY_FILTER_CRITERIA,
  filterProblems,
  isFilterActive,
  toggleTagFilter,
} from "./problem-filter";

const sample = (over: Partial<ProblemSummary> = {}): ProblemSummary => ({
  id: "hello-world",
  name: "Hello World",
  category: "Challenge",
  status: "ready",
  shortDescription: "SSM Parameter 値を当てる flag 問題",
  difficulty: 1,
  estimatedDuration: "30 分",
  tags: ["sample", "challenge", "ssm", "flag"],
  runtime: { provider: "aws", engine: "cloudformation" },
  ...over,
});

describe("filterProblems (Issue #834)", () => {
  const problems: readonly ProblemSummary[] = [
    sample({ id: "p1", name: "Hello World", category: "Challenge", tags: ["sample", "flag"] }),
    sample({
      id: "p2",
      name: "Battle Royale",
      category: "Battle",
      status: "draft",
      difficulty: 4,
      tags: ["battle", "uptime", "ec2"],
    }),
    sample({
      id: "p3",
      name: "Microservice Migration",
      category: "Battle",
      difficulty: 5,
      tags: ["battle", "migration", "ec2", "lambda"],
    }),
  ];

  it("should return all items for empty criteria", () => {
    expect(filterProblems(problems, EMPTY_FILTER_CRITERIA)).toHaveLength(3);
  });

  it("should keep items whose name substring-matches search (case-insensitive)", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "BATTLE" });
    expect(res.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("should scan shortDescription / tags for search as well", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "migration" });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("should narrow via AND when one category filter is specified", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, categories: ["Battle"] });
    expect(res.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("should keep only draft items via status filter", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, statuses: ["draft"] });
    expect(res.map((p) => p.id)).toEqual(["p2"]);
  });

  it("should keep multiple levels via OR for difficulty multi-select", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      difficulties: [1, 5],
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("should keep rows that contain any tag when tag filter mode=or", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      tags: ["lambda", "flag"],
      tagMatchMode: "or",
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("should keep only rows that contain all tags when tag filter mode=and", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      tags: ["ec2", "lambda"],
      tagMatchMode: "and",
    });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("should combine multiple filters via AND", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      search: "battle",
      categories: ["Battle"],
      difficulties: [5],
    });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("should return an empty array on zero hits (= UI handles empty state)", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "nonexistent" });
    expect(res).toEqual([]);
  });

  it("should match the problem id via free-text search (Issue #1776)", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "p2" });
    expect(res.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("filterProblems scoring kind (Issue #1776)", () => {
  const problems: readonly ProblemSummary[] = [
    sample({ id: "p1", scoringKind: "flag" }),
    sample({ id: "p2", scoringKind: "uptime-flat" }),
    sample({ id: "p3" }), // scoring 未宣言 (= deploy のみ) の問題
  ];

  it("should keep only problems whose scoring kind is selected", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, scoringKinds: ["flag"] });
    expect(res.map((p) => p.id)).toEqual(["p1"]);
  });

  it("should OR multiple selected scoring kinds", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      scoringKinds: ["flag", "uptime-flat"],
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("should drop problems without a scoring declaration when the kind filter is active", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      scoringKinds: ["flag", "uptime-flat", "uptime-multi"],
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("should keep problems without a scoring declaration when no kind filter is active", () => {
    expect(filterProblems(problems, EMPTY_FILTER_CRITERIA)).toHaveLength(3);
  });
});

describe("isFilterActive", () => {
  it("should return active=false for empty criteria", () => {
    expect(isFilterActive(EMPTY_FILTER_CRITERIA)).toBe(false);
  });

  it("should return active=true even with a single search character", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, search: "x" })).toBe(true);
  });

  it("should return active when at least one filter is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, categories: ["Battle"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, tags: ["sample"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, difficulties: [1] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, scoringKinds: ["flag"] })).toBe(true);
  });

  it("should return active=false for whitespace-only search (= trim comparison)", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, search: "   " })).toBe(false);
  });
});

describe("collectTagFacets", () => {
  it("should sort by descending frequency with alphabetical tiebreaker", () => {
    const problems = [
      sample({ id: "p1", tags: ["a", "b", "c"] }),
      sample({ id: "p2", tags: ["a", "b"] }),
      sample({ id: "p3", tags: ["a"] }),
    ];
    const facets = collectTagFacets(problems);
    expect(facets).toEqual([
      { tag: "a", count: 3 },
      { tag: "b", count: 2 },
      { tag: "c", count: 1 },
    ]);
  });

  it("should return empty facets for an empty array", () => {
    expect(collectTagFacets([])).toEqual([]);
  });
});

describe("collectScoringKindFacets (Issue #1776)", () => {
  it("should count kinds and sort by frequency desc with alphabetical tiebreaker", () => {
    const problems = [
      sample({ id: "p1", scoringKind: "flag" }),
      sample({ id: "p2", scoringKind: "flag" }),
      sample({ id: "p3", scoringKind: "uptime-flat" }),
      sample({ id: "p4", scoringKind: "attack-detection" }),
    ];
    expect(collectScoringKindFacets(problems)).toEqual([
      { kind: "flag", count: 2 },
      { kind: "attack-detection", count: 1 },
      { kind: "uptime-flat", count: 1 },
    ]);
  });

  it("should skip problems without a scoring declaration", () => {
    const problems = [sample({ id: "p1" }), sample({ id: "p2", scoringKind: "flag" })];
    expect(collectScoringKindFacets(problems)).toEqual([{ kind: "flag", count: 1 }]);
  });

  it("should return empty facets for an empty catalog", () => {
    expect(collectScoringKindFacets([])).toEqual([]);
  });
});

describe("DIFFICULTY_LEVELS", () => {
  it("should enumerate the five catalog difficulty levels in ascending order", () => {
    expect(DIFFICULTY_LEVELS).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("toggleTagFilter (Issue #835)", () => {
  it("should make only that single tag active when clicking one tag from empty", () => {
    const next = toggleTagFilter(EMPTY_FILTER_CRITERIA, "sample");
    expect(next.tags).toEqual(["sample"]);
  });

  it("should clear (toggle) when clicking the same tag that is already the only active one", () => {
    const start = { ...EMPTY_FILTER_CRITERIA, tags: ["sample"] };
    const next = toggleTagFilter(start, "sample");
    expect(next.tags).toEqual([]);
  });

  it("should switch to 'narrow by that tag only' when another tag is active (= single click is full replace)", () => {
    const start = { ...EMPTY_FILTER_CRITERIA, tags: ["sample"] };
    const next = toggleTagFilter(start, "battle");
    expect(next.tags).toEqual(["battle"]);
  });

  it("should preserve other filters (search / category etc.)", () => {
    const start = {
      ...EMPTY_FILTER_CRITERIA,
      search: "x",
      categories: ["Battle"] as const,
      tags: ["sample"],
    };
    const next = toggleTagFilter(start, "flag");
    expect(next.search).toBe("x");
    expect(next.categories).toEqual(["Battle"]);
    expect(next.tags).toEqual(["flag"]);
  });
});
