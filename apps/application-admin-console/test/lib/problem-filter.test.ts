import { describe, expect, it } from "vitest";
import type { ProblemSummary } from "../../src/data/problems";
import {
  collectTagFacets,
  EMPTY_FILTER_CRITERIA,
  filterProblems,
  isFilterActive,
  type ProblemFilterCriteria,
  toggleTagFilter,
} from "../../src/lib/problem-filter";

/**
 * Issue #834 / #835: 問題カタログ filter の pure logic。 検索 (name / shortDescription / tags
 * substring) / category / status / difficulty / tag (OR・AND) の AND 合成、 tag facet の
 * 頻度降順+タイ時 alphabetical sort、 toggleTagFilter の click toggle を pin する。
 */
function p(over: Partial<ProblemSummary> & { id: string }): ProblemSummary {
  return {
    name: `Problem ${over.id}`,
    category: "Challenge",
    status: "ready",
    shortDescription: "a sample problem",
    difficulty: 3,
    estimatedDuration: "30m",
    tags: [],
    ...over,
  };
}

const criteria = (over: Partial<ProblemFilterCriteria>): ProblemFilterCriteria => ({
  ...EMPTY_FILTER_CRITERIA,
  ...over,
});

describe("isFilterActive", () => {
  it("should be false for the empty criteria", () => {
    expect(isFilterActive(EMPTY_FILTER_CRITERIA)).toBe(false);
    // whitespace-only search counts as inactive.
    expect(isFilterActive(criteria({ search: "   " }))).toBe(false);
  });

  it("should be true when any dimension is set", () => {
    expect(isFilterActive(criteria({ search: "x" }))).toBe(true);
    expect(isFilterActive(criteria({ categories: ["Battle"] }))).toBe(true);
    expect(isFilterActive(criteria({ statuses: ["draft"] }))).toBe(true);
    expect(isFilterActive(criteria({ difficulties: [5] }))).toBe(true);
    expect(isFilterActive(criteria({ tags: ["aws"] }))).toBe(true);
  });
});

describe("filterProblems", () => {
  const catalog = [
    p({
      id: "a",
      name: "Redis Spike",
      category: "Battle",
      status: "ready",
      difficulty: 4,
      tags: ["aws", "redis"],
    }),
    p({
      id: "b",
      name: "Hello World",
      category: "Challenge",
      status: "draft",
      difficulty: 1,
      tags: ["aws", "s3"],
    }),
    p({ id: "c", name: "S3 Static", shortDescription: "host a site", difficulty: 2, tags: ["s3"] }),
  ];

  it("should return everything for the empty criteria", () => {
    expect(filterProblems(catalog, EMPTY_FILTER_CRITERIA)).toHaveLength(3);
  });

  it("should search case-insensitively across name / shortDescription / tags", () => {
    expect(filterProblems(catalog, criteria({ search: "REDIS" })).map((x) => x.id)).toEqual(["a"]);
    expect(filterProblems(catalog, criteria({ search: "host a" })).map((x) => x.id)).toEqual(["c"]);
    // tag substring も検索対象。
    expect(
      filterProblems(catalog, criteria({ search: "s3" }))
        .map((x) => x.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("should AND category / status / difficulty filters", () => {
    expect(filterProblems(catalog, criteria({ categories: ["Battle"] })).map((x) => x.id)).toEqual([
      "a",
    ]);
    expect(filterProblems(catalog, criteria({ statuses: ["draft"] })).map((x) => x.id)).toEqual([
      "b",
    ]);
    expect(
      filterProblems(catalog, criteria({ difficulties: [1, 2] }))
        .map((x) => x.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("should treat multi-tag selection as OR by default and AND when requested", () => {
    expect(
      filterProblems(catalog, criteria({ tags: ["redis", "s3"] }))
        .map((x) => x.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(
      filterProblems(catalog, criteria({ tags: ["aws", "s3"], tagMatchMode: "and" })).map(
        (x) => x.id,
      ),
    ).toEqual(["b"]);
  });

  it("should combine dimensions with AND", () => {
    expect(
      filterProblems(catalog, criteria({ categories: ["Challenge"], tags: ["aws"] })).map(
        (x) => x.id,
      ),
    ).toEqual(["b"]);
  });
});

describe("collectTagFacets", () => {
  it("should count tag occurrences and sort by frequency desc, then alphabetically on ties", () => {
    const facets = collectTagFacets([
      p({ id: "1", tags: ["aws", "redis"] }),
      p({ id: "2", tags: ["aws", "s3"] }),
      p({ id: "3", tags: ["s3"] }),
    ]);
    // aws=2, s3=2, redis=1 → count 降順、 同 count は alphabetical (aws < s3) で安定。
    expect(facets).toEqual([
      { tag: "aws", count: 2 },
      { tag: "s3", count: 2 },
      { tag: "redis", count: 1 },
    ]);
  });

  it("should return [] for an empty catalog", () => {
    expect(collectTagFacets([])).toEqual([]);
  });
});

describe("toggleTagFilter", () => {
  it("should set the criteria to filter by a single tag when none / another tag was active", () => {
    expect(toggleTagFilter(EMPTY_FILTER_CRITERIA, "aws").tags).toEqual(["aws"]);
    expect(toggleTagFilter(criteria({ tags: ["s3"] }), "aws").tags).toEqual(["aws"]);
    expect(toggleTagFilter(criteria({ tags: ["a", "b"] }), "aws").tags).toEqual(["aws"]);
  });

  it("should clear the tag filter when clicking the only active tag (= toggle off)", () => {
    expect(toggleTagFilter(criteria({ tags: ["aws"] }), "aws").tags).toEqual([]);
  });
});
