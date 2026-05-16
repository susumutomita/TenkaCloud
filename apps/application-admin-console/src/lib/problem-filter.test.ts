import { describe, expect, it } from "vitest";
import type { ProblemSummary } from "../data/problems";
import {
  collectTagFacets,
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

  it("空 criteria は全件返すべき", () => {
    expect(filterProblems(problems, EMPTY_FILTER_CRITERIA)).toHaveLength(3);
  });

  it("search が name に substring match すれば残るべき (case-insensitive)", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "BATTLE" });
    expect(res.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("search は shortDescription / tags も走査すべき", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "migration" });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("category filter が 1 つ指定されたら AND 条件で絞るべき", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, categories: ["Battle"] });
    expect(res.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("status filter で draft のみ残すべき", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, statuses: ["draft"] });
    expect(res.map((p) => p.id)).toEqual(["p2"]);
  });

  it("difficulty multi-select で複数 level を OR で残すべき", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      difficulties: [1, 5],
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("tag filter mode=or は いずれか含む 行を残すべき", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      tags: ["lambda", "flag"],
      tagMatchMode: "or",
    });
    expect(res.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("tag filter mode=and は 全て含む 行のみ残すべき", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      tags: ["ec2", "lambda"],
      tagMatchMode: "and",
    });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("複数 filter は AND で組み合わさるべき", () => {
    const res = filterProblems(problems, {
      ...EMPTY_FILTER_CRITERIA,
      search: "battle",
      categories: ["Battle"],
      difficulties: [5],
    });
    expect(res.map((p) => p.id)).toEqual(["p3"]);
  });

  it("0 hit になっても空配列を返す (= UI 側で empty state)", () => {
    const res = filterProblems(problems, { ...EMPTY_FILTER_CRITERIA, search: "nonexistent" });
    expect(res).toEqual([]);
  });
});

describe("isFilterActive", () => {
  it("空 criteria は active=false", () => {
    expect(isFilterActive(EMPTY_FILTER_CRITERIA)).toBe(false);
  });

  it("search 1 文字でも active=true", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, search: "x" })).toBe(true);
  });

  it("各 filter の少なくとも 1 つが non-empty なら active", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, categories: ["Battle"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, tags: ["sample"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, difficulties: [1] })).toBe(true);
  });

  it("search が空白のみは active=false (= trim 比較)", () => {
    expect(isFilterActive({ ...EMPTY_FILTER_CRITERIA, search: "   " })).toBe(false);
  });
});

describe("collectTagFacets", () => {
  it("出現頻度の降順 + タイは alphabetical で sort すべき", () => {
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

  it("空配列なら空 facets", () => {
    expect(collectTagFacets([])).toEqual([]);
  });
});

describe("toggleTagFilter (Issue #835)", () => {
  it("空 → 1 タグ click でそのタグ 1 件のみ active", () => {
    const next = toggleTagFilter(EMPTY_FILTER_CRITERIA, "sample");
    expect(next.tags).toEqual(["sample"]);
  });

  it("既に同タグ 1 件のみ active → 同タグ click で clear (toggle)", () => {
    const start = { ...EMPTY_FILTER_CRITERIA, tags: ["sample"] };
    const next = toggleTagFilter(start, "sample");
    expect(next.tags).toEqual([]);
  });

  it("別タグが active なら 「そのタグだけで絞り込み」 に切り替わるべき (= 単 click は全面切替)", () => {
    const start = { ...EMPTY_FILTER_CRITERIA, tags: ["sample"] };
    const next = toggleTagFilter(start, "battle");
    expect(next.tags).toEqual(["battle"]);
  });

  it("他 filter (search / category 等) は維持すべき", () => {
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
