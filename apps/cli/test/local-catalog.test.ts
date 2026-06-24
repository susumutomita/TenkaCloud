import { describe, expect, it } from "vitest";
import {
  type CatalogFs,
  findProblem,
  type LocalCatalogProblem,
  loadLocalCatalog,
  localPracticeFlag,
} from "../src/local/catalog.ts";

/**
 * In-memory fake of the injected `CatalogFs`. The fake is driven by two maps:
 *   - `dirs`: directory path -> entry names returned by readdirSync
 *   - `files`: file path -> raw contents returned by readFileSync
 * existsSync is true for any path that appears as a directory key, a file key,
 * or is reachable as `${dir}/${entry}` of a listed directory. statIsDirectory is
 * true only for directory keys (so a path can "exist" as a file but not be a dir).
 */
function makeFs(opts: {
  dirs?: Record<string, readonly string[]>;
  files?: Record<string, string>;
  /** Paths that exist on disk but are NOT directories (e.g. challenges/ is a file). */
  nonDirExisting?: readonly string[];
}): CatalogFs {
  const dirs = opts.dirs ?? {};
  const files = opts.files ?? {};
  const nonDirExisting = new Set(opts.nonDirExisting ?? []);

  const dirChildren = new Set<string>();
  for (const [dir, entries] of Object.entries(dirs)) {
    for (const e of entries) dirChildren.add(`${dir}/${e}`);
  }

  return {
    existsSync(path: string): boolean {
      if (path in dirs) return true;
      if (path in files) return true;
      if (nonDirExisting.has(path)) return true;
      return dirChildren.has(path);
    },
    readdirSync(path: string): readonly string[] {
      return dirs[path] ?? [];
    },
    readFileSync(path: string, encoding: "utf8"): string {
      expect(encoding).toBe("utf8");
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    statIsDirectory(path: string): boolean {
      return path in dirs;
    },
  };
}

const ROOT = "/problems";

describe("loadLocalCatalog group traversal", () => {
  it("should return an empty array when neither group dir exists", () => {
    const fs = makeFs({});
    expect(loadLocalCatalog(ROOT, fs)).toEqual([]);
  });

  it("should read problems from both challenges and battles groups", () => {
    const fs = makeFs({
      dirs: {
        [`${ROOT}/challenges`]: ["c1"],
        [`${ROOT}/battles`]: ["b1"],
      },
      files: {
        [`${ROOT}/challenges/c1/metadata.json`]: JSON.stringify({
          id: "c1",
          category: "Challenge",
        }),
        [`${ROOT}/battles/b1/metadata.json`]: JSON.stringify({ id: "b1", category: "Battle" }),
      },
    });
    const result = loadLocalCatalog(ROOT, fs);
    expect(result.map((p) => p.problemId)).toEqual(["b1", "c1"]);
    expect(result.map((p) => p.category)).toEqual(["Battle", "Challenge"]);
  });

  it("should read only challenges when battles group is absent", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["c1"] },
      files: {
        [`${ROOT}/challenges/c1/metadata.json`]: JSON.stringify({ id: "c1" }),
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["c1"]);
  });

  it("should read only battles when challenges group is absent", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/battles`]: ["b1"] },
      files: {
        [`${ROOT}/battles/b1/metadata.json`]: JSON.stringify({ id: "b1" }),
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["b1"]);
  });

  it("should skip a group whose path exists but is not a directory", () => {
    // challenges exists (as a file) but statIsDirectory is false → skipped.
    const fs = makeFs({
      dirs: { [`${ROOT}/battles`]: ["b1"] },
      files: {
        [`${ROOT}/battles/b1/metadata.json`]: JSON.stringify({ id: "b1" }),
      },
      nonDirExisting: [`${ROOT}/challenges`],
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["b1"]);
  });
});

describe("loadLocalCatalog entry handling", () => {
  it("should skip an entry that has no metadata.json", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["has-meta", "no-meta"] },
      files: {
        [`${ROOT}/challenges/has-meta/metadata.json`]: JSON.stringify({ id: "has-meta" }),
        // no-meta/metadata.json is intentionally absent
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["has-meta"]);
  });

  it("should skip an entry with malformed JSON but keep the others", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["broken", "good"] },
      files: {
        [`${ROOT}/challenges/broken/metadata.json`]: "{ not valid json ",
        [`${ROOT}/challenges/good/metadata.json`]: JSON.stringify({ id: "good" }),
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["good"]);
  });

  it("should fall back to the directory name when metadata has no id", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["dir-name"] },
      files: {
        // valid JSON, id missing → problemId falls back to entry "dir-name"
        [`${ROOT}/challenges/dir-name/metadata.json`]: JSON.stringify({ name: "No Id" }),
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["dir-name"]);
  });
});

describe("loadLocalCatalog metadata normalization", () => {
  function loadSingle(meta: unknown): LocalCatalogProblem {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["p"] },
      files: {
        [`${ROOT}/challenges/p/metadata.json`]: JSON.stringify(meta),
      },
    });
    const result = loadLocalCatalog(ROOT, fs);
    expect(result).toHaveLength(1);
    return result[0] as LocalCatalogProblem;
  }

  it("should map a fully populated metadata document", () => {
    // kind=flag: local catalog は flag kind だけを残すので、 normalization の全 field を
    // 1 件として観測するには解ける kind を使う (= 非 flag は filter テストで別途網羅)。
    const problem = loadSingle({
      id: "full",
      name: "Full Problem",
      category: "Battle",
      description: "A description",
      instructions: "Do the thing",
      scoring: {
        kind: "flag",
        points: 250,
        hints: [{ id: "h1", penalty: 10, content: "hint text" }],
      },
      endpoints: [
        {
          slot: "web",
          label: "Web URL",
          description: "the site",
          overridable: true,
          default: { key: "WebUrl" },
        },
      ],
    });
    expect(problem).toEqual({
      problemId: "full",
      name: "Full Problem",
      category: "Battle",
      description: "A description",
      instructions: "Do the thing",
      scoringKind: "flag",
      points: 250,
      hints: [{ id: "h1", penalty: 10, content: "hint text" }],
      endpoints: [
        {
          slot: "web",
          label: "Web URL",
          description: "the site",
          overridable: true,
          defaultKey: "WebUrl",
        },
      ],
    });
  });

  it("should apply category/name/scoring fallbacks when fields are missing", () => {
    // category → "Challenge", name → problemId, scoringKind → "flag", points → 0.
    const problem = loadSingle({ id: "bare" });
    expect(problem.category).toBe("Challenge");
    expect(problem.name).toBe("bare");
    expect(problem.description).toBe("");
    expect(problem.instructions).toBe("");
    expect(problem.scoringKind).toBe("flag");
    expect(problem.points).toBe(0);
    expect(problem.hints).toEqual([]);
    expect(problem.endpoints).toEqual([]);
  });

  it("should apply fallbacks when fields have the wrong type", () => {
    // Non-string name/category/description, non-number points, non-finite points,
    // non-object scoring.kind, non-array hints/endpoints all hit the fallbacks.
    const problem = loadSingle({
      id: "typed",
      name: 123,
      category: false,
      description: { not: "a string" },
      instructions: [1, 2],
      scoring: { kind: 99, points: Number.NaN, hints: "not an array" },
      endpoints: "not an array",
    });
    expect(problem.name).toBe("typed");
    expect(problem.category).toBe("Challenge");
    expect(problem.description).toBe("");
    expect(problem.instructions).toBe("");
    expect(problem.scoringKind).toBe("flag");
    expect(problem.points).toBe(0);
    expect(problem.hints).toEqual([]);
    expect(problem.endpoints).toEqual([]);
  });

  it("should default scoring to an empty object when scoring is absent", () => {
    // meta.scoring undefined → `meta.scoring ?? {}` branch.
    const problem = loadSingle({ id: "no-scoring", name: "N" });
    expect(problem.scoringKind).toBe("flag");
    expect(problem.points).toBe(0);
    expect(problem.hints).toEqual([]);
  });
});

describe("normalizeHints (via loadLocalCatalog)", () => {
  function hintsOf(hints: unknown): LocalCatalogProblem["hints"] {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["p"] },
      files: {
        [`${ROOT}/challenges/p/metadata.json`]: JSON.stringify({ id: "p", scoring: { hints } }),
      },
    });
    return (loadLocalCatalog(ROOT, fs)[0] as LocalCatalogProblem).hints;
  }

  it("should return an empty array when hints is not an array", () => {
    expect(hintsOf({ a: 1 })).toEqual([]);
  });

  it("should skip non-object and null hint entries", () => {
    expect(hintsOf(["string", 42, null, true])).toEqual([]);
  });

  it("should skip a hint entry that has no id", () => {
    expect(hintsOf([{ penalty: 5, content: "x" }])).toEqual([]);
  });

  it("should normalize a hint and default missing penalty/content", () => {
    expect(hintsOf([{ id: "h1" }])).toEqual([{ id: "h1", penalty: 0, content: "" }]);
  });

  it("should keep valid hints while skipping invalid ones", () => {
    expect(
      hintsOf([{ id: "h1", penalty: 3, content: "c" }, { content: "no id" }, { id: "h2" }]),
    ).toEqual([
      { id: "h1", penalty: 3, content: "c" },
      { id: "h2", penalty: 0, content: "" },
    ]);
  });
});

describe("normalizeEndpoints (via loadLocalCatalog)", () => {
  function endpointsOf(endpoints: unknown): LocalCatalogProblem["endpoints"] {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["p"] },
      files: {
        [`${ROOT}/challenges/p/metadata.json`]: JSON.stringify({ id: "p", endpoints }),
      },
    });
    return (loadLocalCatalog(ROOT, fs)[0] as LocalCatalogProblem).endpoints;
  }

  it("should return an empty array when endpoints is not an array", () => {
    expect(endpointsOf({ a: 1 })).toEqual([]);
  });

  it("should skip non-object and null endpoint entries", () => {
    expect(endpointsOf(["str", 0, null])).toEqual([]);
  });

  it("should skip an endpoint entry that has no slot", () => {
    expect(endpointsOf([{ label: "no slot", overridable: true }])).toEqual([]);
  });

  it("should default overridable to false unless strictly true", () => {
    // overridable is "true" (string) → not strictly true → false.
    expect(endpointsOf([{ slot: "s", overridable: "true" }])).toEqual([
      { slot: "s", overridable: false, defaultKey: "" },
    ]);
  });

  it("should default defaultKey to empty when default.key is absent", () => {
    // default object present but no key, and no default object at all.
    expect(endpointsOf([{ slot: "a", default: {} }, { slot: "b" }])).toEqual([
      { slot: "a", overridable: false, defaultKey: "" },
      { slot: "b", overridable: false, defaultKey: "" },
    ]);
  });

  it("should read default.key when present", () => {
    expect(endpointsOf([{ slot: "s", default: { key: "MyKey" } }])).toEqual([
      { slot: "s", overridable: false, defaultKey: "MyKey" },
    ]);
  });

  it("should include label only when it is a string", () => {
    const result = endpointsOf([
      { slot: "with", label: "Has Label" },
      { slot: "without", label: 42 },
    ]);
    expect(result[0]).toHaveProperty("label", "Has Label");
    expect(result[1]).not.toHaveProperty("label");
  });

  it("should include description only when it is a string", () => {
    const result = endpointsOf([
      { slot: "with", description: "Has Desc" },
      { slot: "without", description: { x: 1 } },
    ]);
    expect(result[0]).toHaveProperty("description", "Has Desc");
    expect(result[1]).not.toHaveProperty("description");
  });
});

describe("loadLocalCatalog sorting", () => {
  it("should sort problems by problemId using localeCompare", () => {
    const fs = makeFs({
      dirs: {
        [`${ROOT}/challenges`]: ["zeta", "alpha"],
        [`${ROOT}/battles`]: ["mike"],
      },
      files: {
        [`${ROOT}/challenges/zeta/metadata.json`]: JSON.stringify({ id: "zeta" }),
        [`${ROOT}/challenges/alpha/metadata.json`]: JSON.stringify({ id: "alpha" }),
        [`${ROOT}/battles/mike/metadata.json`]: JSON.stringify({ id: "mike" }),
      },
    });
    expect(loadLocalCatalog(ROOT, fs).map((p) => p.problemId)).toEqual(["alpha", "mike", "zeta"]);
  });
});

describe("loadLocalCatalog local-solvable filter", () => {
  // flag kind = 解ける / それ以外 = AWS deploy が要るので非表示、 を 1 つの fs で混在させる。
  function mixedFs(): CatalogFs {
    return makeFs({
      dirs: {
        [`${ROOT}/challenges`]: ["flag-c", "uptime-c", "no-kind-c"],
        [`${ROOT}/battles`]: ["multi-b", "phased-b"],
      },
      files: {
        // flag → kept
        [`${ROOT}/challenges/flag-c/metadata.json`]: JSON.stringify({
          id: "flag-c",
          scoring: { kind: "flag", points: 100 },
        }),
        // uptime-flat → filtered
        [`${ROOT}/challenges/uptime-c/metadata.json`]: JSON.stringify({
          id: "uptime-c",
          scoring: { kind: "uptime-flat", points: 200 },
        }),
        // no scoring.kind → defaults to flag → kept
        [`${ROOT}/challenges/no-kind-c/metadata.json`]: JSON.stringify({ id: "no-kind-c" }),
        // multi-flag → filtered (local does not score multiple flags)
        [`${ROOT}/battles/multi-b/metadata.json`]: JSON.stringify({
          id: "multi-b",
          scoring: { kind: "multi-flag", points: 500 },
        }),
        // phased-polling → filtered
        [`${ROOT}/battles/phased-b/metadata.json`]: JSON.stringify({
          id: "phased-b",
          scoring: { kind: "phased-polling", points: 300 },
        }),
      },
    });
  }

  it("should keep only flag-kind problems (incl. metadata with no kind)", () => {
    const kept = loadLocalCatalog(ROOT, mixedFs()).map((p) => p.problemId);
    expect(kept).toEqual(["flag-c", "no-kind-c"]);
  });

  it("should drop uptime/multi-flag/phased problems that need live AWS", () => {
    const kept = loadLocalCatalog(ROOT, mixedFs()).map((p) => p.problemId);
    expect(kept).not.toContain("uptime-c");
    expect(kept).not.toContain("multi-b");
    expect(kept).not.toContain("phased-b");
  });

  it("should log the hidden count and ids when a log callback is provided", () => {
    const lines: string[] = [];
    loadLocalCatalog(ROOT, mixedFs(), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    // honest, not silent: 3 hidden, sorted ids surfaced for the operator.
    expect(lines[0]).toBe(
      "3 problems hidden in local mode (need AWS deploy: multi-b, phased-b, uptime-c)",
    );
  });

  it("should not log when no problems are hidden", () => {
    const fs = makeFs({
      dirs: { [`${ROOT}/challenges`]: ["flag-only"] },
      files: {
        [`${ROOT}/challenges/flag-only/metadata.json`]: JSON.stringify({
          id: "flag-only",
          scoring: { kind: "flag" },
        }),
      },
    });
    const lines: string[] = [];
    const kept = loadLocalCatalog(ROOT, fs, (line) => lines.push(line));
    expect(kept.map((p) => p.problemId)).toEqual(["flag-only"]);
    expect(lines).toEqual([]);
  });

  it("should filter silently when no log callback is provided", () => {
    // log 省略時 (= 純カタログ取得) は警告を出さず filter のみ。
    const kept = loadLocalCatalog(ROOT, mixedFs());
    expect(kept.map((p) => p.problemId)).toEqual(["flag-c", "no-kind-c"]);
  });
});

describe("findProblem", () => {
  const catalog: LocalCatalogProblem[] = [
    {
      problemId: "p1",
      category: "Challenge",
      name: "P1",
      description: "",
      instructions: "",
      scoringKind: "flag",
      points: 0,
      hints: [],
      endpoints: [],
    },
    {
      problemId: "p2",
      category: "Battle",
      name: "P2",
      description: "",
      instructions: "",
      scoringKind: "flag",
      points: 0,
      hints: [],
      endpoints: [],
    },
  ];

  it("should return the matching problem when present", () => {
    expect(findProblem(catalog, "p2")?.name).toBe("P2");
  });

  it("should return undefined when no problem matches", () => {
    expect(findProblem(catalog, "missing")).toBeUndefined();
  });
});

describe("localPracticeFlag", () => {
  it("should derive a deterministic flag from the problemId", () => {
    expect(localPracticeFlag("my-problem")).toBe("TC{local-my-problem}");
  });

  it("should be stable across calls", () => {
    expect(localPracticeFlag("x")).toBe(localPracticeFlag("x"));
  });
});
