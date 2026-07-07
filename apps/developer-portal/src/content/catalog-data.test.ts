import { describe, expect, it } from "vitest";
import { CATALOG_DATA } from "./catalog-data";

// Integrity tests for the COMMITTED catalog data. These are intentionally
// submodule-independent: they assert the shape and invariants of the generated
// artifact (src/content/catalog-data.ts), so they stay green whether or not the
// problems/ submodule is checked out. The drift-vs-submodule check is the separate
// maintainer tool `bun run check:catalog` (it needs the submodule), NOT a CI gate —
// the pin bump is a bot PR that bypasses parent CI, so coupling a hard gate to it
// would surprise unrelated PRs.
const CATEGORY_ORDER = { Battle: 0, Challenge: 1 } as const;
const STATUS_ORDER = { ready: 0, draft: 1, deprecated: 2 } as const;

describe("committed catalog data", () => {
  it("should list at least one Battle and one Challenge", () => {
    const categories = new Set(CATALOG_DATA.problems.map((problem) => problem.category));
    expect(categories.has("Battle")).toBe(true);
    expect(categories.has("Challenge")).toBe(true);
  });

  it("should carry a valid, bilingual, uniquely-identified entry for every problem", () => {
    const ids = new Set<string>();
    for (const problem of CATALOG_DATA.problems) {
      expect(problem.id.length).toBeGreaterThan(0);
      expect(ids.has(problem.id)).toBe(false);
      ids.add(problem.id);
      expect(["Battle", "Challenge"]).toContain(problem.category);
      expect(["ready", "draft", "deprecated"]).toContain(problem.status);
      expect(problem.difficulty).toBeGreaterThanOrEqual(1);
      expect(problem.difficulty).toBeLessThanOrEqual(5);
      expect(problem.name.ja.length).toBeGreaterThan(0);
      expect(problem.name.en.length).toBeGreaterThan(0);
      expect(Array.isArray(problem.tags)).toBe(true);
      expect(problem.tags.length).toBeLessThanOrEqual(4);
    }
  });

  it("should be in the deterministic generated order (Battle→Challenge, ready→draft, easy→hard, id)", () => {
    const problems = CATALOG_DATA.problems;
    for (let i = 1; i < problems.length; i++) {
      const prev = problems[i - 1];
      const curr = problems[i];
      const byCategory = CATEGORY_ORDER[prev.category] - CATEGORY_ORDER[curr.category];
      const byStatus = STATUS_ORDER[prev.status] - STATUS_ORDER[curr.status];
      const byDifficulty = prev.difficulty - curr.difficulty;
      const byId = prev.id.localeCompare(curr.id);
      // The first non-zero comparator must be strictly negative (prev sorts before curr).
      const firstDiff =
        [byCategory, byStatus, byDifficulty, byId].find((delta) => delta !== 0) ?? 0;
      expect(firstDiff).toBeLessThanOrEqual(0);
    }
  });

  it("should only contain publicly visible problems (private problems are excluded by the generator)", () => {
    // The generator filters visibility === "public"; there is no visibility field on
    // the committed shape, so this asserts the surface stays display-only.
    for (const problem of CATALOG_DATA.problems) {
      expect(problem).not.toHaveProperty("visibility");
    }
  });
});
