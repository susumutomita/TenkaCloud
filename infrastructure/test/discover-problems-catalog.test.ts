import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverProblemsCatalog,
  discoverProblemsCoordination,
  discoverProblemsDisruptions,
  discoverProblemsScoring,
  discoverProblemsVisibility,
  discoverProblemsWriteups,
} from "../lib/utils/discover-problems-catalog";

/**
 * discoverProblemsCatalog: `problems/<category>/<id>/metadata.json` を 2 階層 scan して
 * `{ [problemId]: problemDir }` map を返す。CDK synth 時に bin/infrastructure.ts から呼ぶ。
 *
 * 設計意図:
 *   - 不正な metadata は silent skip ではなく console.warn に出す (operator が気づける)
 *   - problemsRoot 自体が無い場合も throw せず空 map を返す (synth 時に problems/ を埋める前
 *     に typecheck が走るケースの防御)
 *   - id は metadata.json の `id` field から (ディレクトリ名と乖離した場合 metadata 優先)
 */

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "discover-catalog-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeProblem(category: string, dir: string, body: object): void {
  const target = path.join(workspace, category, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "metadata.json"), JSON.stringify(body));
}

describe("discoverProblemsCatalog", () => {
  it("should return all problems with metadata.json as an id → problemDir map", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("battles", "security-battle-royale", { id: "security-battle-royale" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({
      "hello-world": "problems/challenges/hello-world",
      "security-battle-royale": "problems/battles/security-battle-royale",
    });
  });

  it("should adopt the metadata id when it differs from the directory name", () => {
    writeProblem("challenges", "physical-dir-name", { id: "logical-id" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "logical-id": "problems/challenges/physical-dir-name" });
  });

  it("should return an empty map and warn when problemsRoot itself does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = path.join(workspace, "missing-root");

    const catalog = discoverProblemsCatalog(missing);

    expect(catalog).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("not found");
    warn.mockRestore();
  });

  it("should silently skip directories without metadata.json (no warn)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, "challenges", "no-metadata"), { recursive: true });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should warn and skip metadata with broken JSON, collecting the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, "challenges", "broken"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "challenges", "broken", "metadata.json"), "{not-json");
    writeProblem("challenges", "good", { id: "good" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ good: "problems/challenges/good" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("parse failed");
    warn.mockRestore();
  });

  it("should warn and skip metadata with missing / empty id field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeProblem("challenges", "no-id", { name: "no id field" });
    writeProblem("challenges", "empty-id", { id: "" });
    writeProblem("challenges", "good", { id: "good" });

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ good: "problems/challenges/good" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("missing or invalid 'id' field");
    warn.mockRestore();
  });

  it("should ignore files (non-directories) mixed directly under category", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    fs.writeFileSync(path.join(workspace, "README.md"), "not a category");
    fs.writeFileSync(path.join(workspace, "challenges", "stray.txt"), "not a problem dir");

    const catalog = discoverProblemsCatalog(workspace);

    expect(catalog).toEqual({ "hello-world": "problems/challenges/hello-world" });
  });
});

describe("discoverProblemsWriteups (#2191)", () => {
  it("collects complete bilingual pairs and skips incomplete entries", () => {
    writeProblem("challenges", "complete", {
      id: "complete",
      writeup: "日本語",
      i18n: { en: { writeup: "English" } },
    });
    writeProblem("challenges", "ja-only", { id: "ja-only", writeup: "日本語" });
    writeProblem("challenges", "none", { id: "none" });

    expect(discoverProblemsWriteups(workspace)).toEqual({
      complete: { ja: "日本語", en: "English" },
    });
  });
});

// Issue #2086: pin the catalog ordering contract before pack support is added.
describe("discoverProblemsCatalog ordering (#2086)", () => {
  it("should return entries in a repeatable, stable order across calls", () => {
    writeProblem("challenges", "alpha", { id: "alpha" });
    writeProblem("challenges", "bravo", { id: "bravo" });
    writeProblem("battles", "charlie", { id: "charlie" });
    writeProblem("battles", "delta", { id: "delta" });

    const first = Object.keys(discoverProblemsCatalog(workspace));
    const second = Object.keys(discoverProblemsCatalog(workspace));

    expect(first).toHaveLength(4);
    expect(second).toEqual(first); // deterministic: same order on every call
  });

  it("should follow filesystem traversal order without applying its own sort", () => {
    // Names chosen so id-sorted order would differ from category-then-name walk.
    writeProblem("zzz-category", "aaa", { id: "aaa" });
    writeProblem("aaa-category", "zzz", { id: "zzz" });

    // The expected order mirrors the implementation's two-level readdir walk
    // (category dirs, then problem dirs within each), proving no independent
    // alphabetical sort of ids is applied on top.
    const expected: string[] = [];
    for (const category of fs.readdirSync(workspace, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      for (const problem of fs.readdirSync(path.join(workspace, category.name), {
        withFileTypes: true,
      })) {
        if (problem.isDirectory()) expected.push(problem.name); // id === dir name here
      }
    }

    expect(Object.keys(discoverProblemsCatalog(workspace))).toEqual(expected);
  });
});

describe("discoverProblemsScoring", () => {
  it("should collect scoring of flag form", () => {
    writeProblem("challenges", "hello-world", {
      id: "hello-world",
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "hello-world": { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
    });
  });

  it("should collect scoring of uptime form", () => {
    writeProblem("battles", "battle-1", {
      id: "battle-1",
      scoring: {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "battle-1": {
        kind: "uptime",
        endpoints: [{ outputKey: "FrontendUrl", path: "/", expectStatus: [200] }],
        pointsPerSuccess: 50,
      },
    });
  });

  it("should not include problems without scoring in the map", () => {
    writeProblem("challenges", "hello-world", { id: "hello-world" });
    writeProblem("challenges", "with-scoring", {
      id: "with-scoring",
      scoring: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      "with-scoring": { kind: "flag", flagOutputKey: "X", points: 1 },
    });
  });

  it("should drop entries with broken scoring shape (invalid kind / missing required field)", () => {
    writeProblem("challenges", "broken-1", {
      id: "broken-1",
      scoring: { kind: "wrong-kind" },
    });
    writeProblem("challenges", "broken-2", {
      id: "broken-2",
      scoring: { kind: "flag" }, // flagOutputKey / points 欠損
    });
    writeProblem("challenges", "good", {
      id: "good",
      scoring: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
    expect(discoverProblemsScoring(workspace)).toEqual({
      good: { kind: "flag", flagOutputKey: "X", points: 1 },
    });
  });
});

// Issue #642: visibility 抜き出し
describe("discoverProblemsVisibility (Issue #642)", () => {
  it("should map only visibility=private problems (omit public)", () => {
    writeProblem("challenges", "public-one", { id: "public-one", visibility: "public" });
    writeProblem("battles", "private-one", { id: "private-one", visibility: "private" });
    writeProblem("battles", "no-visibility", { id: "no-visibility" });
    expect(discoverProblemsVisibility(workspace)).toEqual({ "private-one": "private" });
  });

  it("空 workspace は空 map (= 全 public 扱い)", () => {
    expect(discoverProblemsVisibility(workspace)).toEqual({});
  });
});

describe("discoverProblemsDisruptions triggers[] (#1422)", () => {
  it("should surface condition triggers parsed from metadata.disruptions[]", () => {
    writeProblem("battles", "latency-battle", {
      id: "latency-battle",
      disruptions: [
        {
          id: "latency",
          name: "EC2 latency",
          eventDetailType: "DegradedDisruptionFired",
          parameters: { delayMs: 200 },
          triggers: [
            { kind: "after-deploy", afterMinutes: 60 },
            { kind: "team-score-above", threshold: 5000 },
            { kind: "bogus" },
          ],
        },
      ],
    });
    const result = discoverProblemsDisruptions(workspace);
    expect(result["latency-battle"]?.[0]?.triggers).toEqual([
      { kind: "after-deploy", afterMinutes: 60 },
      { kind: "team-score-above", threshold: 5000 },
    ]);
  });

  it("should omit triggers when the disruption declares none (Phase 1 self-fire only)", () => {
    writeProblem("battles", "plain-battle", {
      id: "plain-battle",
      disruptions: [{ id: "d1", name: "n", eventDetailType: "X" }],
    });
    expect(discoverProblemsDisruptions(workspace)["plain-battle"]?.[0]?.triggers).toBeUndefined();
  });

  it("should surface a valid scoring effect and drop a malformed one (#1665)", () => {
    writeProblem("battles", "effect-battle", {
      id: "effect-battle",
      disruptions: [
        {
          id: "ceo-pressure",
          name: "CEO pressure",
          eventDetailType: "X",
          effect: { kind: "penalty", points: 40, durationSeconds: 300 },
        },
        {
          id: "bad-effect",
          name: "bad",
          eventDetailType: "X",
          effect: { kind: "unavailability", points: 1, durationSeconds: 1 }, // unknown kind → dropped
        },
      ],
    });
    const entries = discoverProblemsDisruptions(workspace)["effect-battle"];
    expect(entries?.[0]?.effect).toEqual({ kind: "penalty", points: 40, durationSeconds: 300 });
    expect(entries?.[1]?.effect).toBeUndefined(); // fail-safe drop, entry still kept
  });

  it("should surface a valid recurrence and drop a malformed one", () => {
    writeProblem("battles", "recur-battle", {
      id: "recur-battle",
      disruptions: [
        {
          id: "score-storm",
          name: "Score storm",
          eventDetailType: "X",
          triggers: [{ kind: "team-score-above", threshold: 1000 }],
          recurrence: { intervalMinutes: 5, maxFires: 6 },
        },
        {
          id: "bad-recur",
          name: "bad",
          eventDetailType: "X",
          recurrence: { intervalMinutes: 0, maxFires: 6 }, // <1 → dropped
        },
      ],
    });
    const entries = discoverProblemsDisruptions(workspace)["recur-battle"];
    expect(entries?.[0]?.recurrence).toEqual({ intervalMinutes: 5, maxFires: 6 });
    expect(entries?.[1]?.recurrence).toBeUndefined(); // fail-safe drop, entry still kept
  });
});

describe("discoverProblemsCoordination (#1420)", () => {
  it("should collect interTeamCoordination.plugin per problem", () => {
    writeProblem("battles", "router-battle", {
      id: "router-battle",
      interTeamCoordination: { plugin: "coordination/router.ts", name: "Router" },
    });
    expect(discoverProblemsCoordination(workspace)).toEqual({
      "router-battle": { plugin: "coordination/router.ts", scoreMode: "exclusive" },
    });
  });

  it("preserves ordinary scoring when coordination is also declared", () => {
    writeProblem("battles", "mixed", {
      id: "mixed",
      scoring: { schedule: "rate(1 minute)" },
      interTeamCoordination: { plugin: "coordination/mixed.ts" },
    });
    expect(discoverProblemsCoordination(workspace).mixed).toEqual({
      plugin: "coordination/mixed.ts",
      scoreMode: "additive",
    });
  });

  it("should omit problems without a valid coordination plugin path", () => {
    writeProblem("challenges", "no-coord", { id: "no-coord" });
    writeProblem("battles", "empty-plugin", { id: "empty-plugin", interTeamCoordination: {} });
    writeProblem("battles", "non-string", {
      id: "non-string",
      interTeamCoordination: { plugin: 42 },
    });
    writeProblem("battles", "array-coord", { id: "array-coord", interTeamCoordination: [] });
    expect(discoverProblemsCoordination(workspace)).toEqual({});
  });

  /**
   * [Issue #3169] The state budget rides along with the plugin path, because
   * the platform refuses a deploy that cannot fit it. A declaration the
   * discovery half-accepts is worse than one it drops: the platform would then
   * treat the problem as declared and read the missing side as zero, which
   * admits exactly the event this check exists to refuse.
   */
  it("should carry a complete stateBudget declaration", () => {
    writeProblem("battles", "sized-battle", {
      id: "sized-battle",
      interTeamCoordination: {
        plugin: "coordination/sized.ts",
        stateBudget: { bytesPerTeam: 17001, baseBytes: 1152 },
      },
    });
    expect(discoverProblemsCoordination(workspace)["sized-battle"]).toEqual({
      plugin: "coordination/sized.ts",
      scoreMode: "exclusive",
      stateBudget: { bytesPerTeam: 17001, baseBytes: 1152 },
    });
  });

  it.each([
    ["only bytesPerTeam", { bytesPerTeam: 17001 }],
    ["only baseBytes", { baseBytes: 1152 }],
    ["a zero per-team cost", { bytesPerTeam: 0, baseBytes: 1152 }],
    ["a negative base", { bytesPerTeam: 17001, baseBytes: -1 }],
    ["a fractional cost", { bytesPerTeam: 1.5, baseBytes: 0 }],
    ["strings", { bytesPerTeam: "17001", baseBytes: "1152" }],
    ["an array", []],
    ["null", null],
  ])("should keep the plugin but drop a stateBudget that is %s", (_label, stateBudget) => {
    writeProblem("battles", "half-declared", {
      id: "half-declared",
      interTeamCoordination: { plugin: "coordination/half.ts", stateBudget },
    });
    // The plugin still loads — only the size check is skipped, which is the
    // same outcome as a problem that never declared a budget at all.
    expect(discoverProblemsCoordination(workspace)["half-declared"]).toEqual({
      plugin: "coordination/half.ts",
      scoreMode: "exclusive",
    });
  });
});
