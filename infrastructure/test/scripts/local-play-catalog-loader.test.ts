import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_INTRO_DRILL_PROBLEM_ID,
  loadProblemCatalogEntries,
  pinIntroDrillFirst,
  problemSearchRoots,
} from "../../../scripts/local-play/catalog-loader";
import { resolveProblemDir } from "../../../scripts/local-play/manifest";

/**
 * [#2696 PR5] `pinIntroDrillFirst` is the single place that decides local play's one
 * fixed intro drill ordering — both the Participant Portal catalog (via
 * `loadLocalPlayCatalog`) and `tenkacloud local list` apply it to whatever the
 * problems/ submodule enumerates, so this is the one seam that needs a unit test
 * (the callers are thin one-line wraps around it).
 */

interface Item {
  readonly problemId: string;
}

function items(...problemIds: readonly string[]): Item[] {
  return problemIds.map((problemId) => ({ problemId }));
}

describe("LOCAL_INTRO_DRILL_PROBLEM_ID", () => {
  it("should be sqli-demo (the documented Docker reference problem)", () => {
    expect(LOCAL_INTRO_DRILL_PROBLEM_ID).toBe("sqli-demo");
  });
});

describe("pinIntroDrillFirst", () => {
  it("should move the intro drill to the front, keeping every other item's relative order", () => {
    const catalog = items("ai-riscv-screen-repair", "csrf-demo", "sqli-demo", "xss-demo");
    expect(pinIntroDrillFirst(catalog).map((i) => i.problemId)).toEqual([
      "sqli-demo",
      "ai-riscv-screen-repair",
      "csrf-demo",
      "xss-demo",
    ]);
  });

  it("should leave the order unchanged when the intro drill is already first", () => {
    const catalog = items("sqli-demo", "csrf-demo", "xss-demo");
    expect(pinIntroDrillFirst(catalog).map((i) => i.problemId)).toEqual([
      "sqli-demo",
      "csrf-demo",
      "xss-demo",
    ]);
  });

  it("should leave the order unchanged when the intro drill is absent", () => {
    const catalog = items("csrf-demo", "xss-demo");
    expect(pinIntroDrillFirst(catalog).map((i) => i.problemId)).toEqual(["csrf-demo", "xss-demo"]);
  });

  it("should not mutate the input array", () => {
    const catalog = items("csrf-demo", "sqli-demo");
    const original = [...catalog];
    pinIntroDrillFirst(catalog);
    expect(catalog).toEqual(original);
  });

  it("should return an empty array unchanged", () => {
    expect(pinIntroDrillFirst([])).toEqual([]);
  });
});

/**
 * [#2925 / #2926] `loadProblemCatalogEntries` is the runtime twin of the portal's
 * build-time `import.meta.glob`. It exists because `.dockerignore` excludes `problems/`
 * on purpose — the image must serve the participant's own bind-mounted clone — which
 * left the glob empty in the image and blanked every catalog-derived surface: problem
 * instructions, learning goals, endpoint overrides, course tracks, plugin slots.
 *
 * The properties pinned here are the ones whose absence produced that outage, or would
 * reintroduce it silently:
 *   - it must project problems the participant has NOT deployed (a course track is a
 *     curriculum view — `listLocalPlayProblems` answers a different question);
 *   - it must apply the same fairness projection as the build-time path, so the
 *     spoiler-bearing `description` cannot reach the wire;
 *   - an unreadable metadata.json must be reported, not silently dropped — from the
 *     portal a vanished problem is indistinguishable from one nobody wrote.
 */
describe("loadProblemCatalogEntries (#2925 / #2926)", () => {
  const CHALLENGES = "/repo/problems/challenges";
  const BATTLES = "/repo/problems/battles";

  function metadata(id: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id,
      name: `${id} name`,
      category: "Challenge",
      status: "ready",
      difficulty: 2,
      estimatedDuration: "30 min",
      shortDescription: `${id} short`,
      description: "SECRET scoring rules — must never reach a participant",
      tags: [],
      learningGoals: [],
      ...extra,
    });
  }

  function fakeFs(tree: Readonly<Record<string, Readonly<Record<string, string>>>>) {
    const files = new Map<string, string>();
    for (const [root, problems] of Object.entries(tree)) {
      for (const [problemId, content] of Object.entries(problems)) {
        files.set(`${root}/${problemId}/metadata.json`, content);
      }
    }
    return {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      readDirNames: (path: string) => Object.keys(tree[path] ?? {}),
    };
  }

  it("should project every problem under every root, sorted by id", () => {
    const { entries, skipped } = loadProblemCatalogEntries(
      [CHALLENGES, BATTLES],
      fakeFs({
        [CHALLENGES]: { "wp-exposed-backup": metadata("wp-exposed-backup") },
        [BATTLES]: { "ac26-bridge": metadata("ac26-bridge") },
      }),
    );
    expect(entries.map((e) => e.id)).toEqual(["ac26-bridge", "wp-exposed-backup"]);
    expect(skipped).toEqual([]);
  });

  /**
   * [TenkaCloudChallenge #402] カタログに出るのに起動できない問題があり、開いて
   * 「deploy されていません。operator にお問い合わせください」に当たって初めて分かる、
   * という行き止まりがあった。local play の operator は本人なので、その案内では何もできない。
   *
   * カタログから消す対処は採らない。#2926 が「学習パスの先が見えること」を理由に AWS 専用
   * 問題を意図的に含めているので、消すとその決定を黙って覆すことになる。代わりに
   * 起動できるかどうかを entry に載せ、ポータルが理由を名指しできるようにする。
   */
  describe("localPlayable (#402)", () => {
    /** metadata.json に加えて `local/` の有無も表現できる fake tree。 */
    function fsWithLocalDirs(
      tree: Readonly<Record<string, Readonly<Record<string, string>>>>,
      withLocal: readonly string[],
    ) {
      const base = fakeFs(tree);
      const localDirs = new Set<string>();
      for (const [root, problems] of Object.entries(tree)) {
        for (const problemId of Object.keys(problems)) {
          if (withLocal.includes(problemId)) localDirs.add(`${root}/${problemId}/local`);
        }
      }
      return { ...base, existsSync: (p: string) => base.existsSync(p) || localDirs.has(p) };
    }

    const TREE = {
      [CHALLENGES]: {
        "sqli-demo": metadata("sqli-demo"),
        "wp2shell-friday-night-patch": metadata("wp2shell-friday-night-patch"),
      },
    };

    it("should mark a problem that ships a local/ directory as playable", () => {
      const { entries } = loadProblemCatalogEntries(
        [CHALLENGES],
        fsWithLocalDirs(TREE, ["sqli-demo"]),
      );
      expect(entries.find((e) => e.id === "sqli-demo")?.localPlayable).toBe(true);
    });

    it("should mark an AWS-only problem as not playable rather than dropping it", () => {
      // 消えていないこと自体が #2926 の維持。印だけが増える。
      const { entries } = loadProblemCatalogEntries(
        [CHALLENGES],
        fsWithLocalDirs(TREE, ["sqli-demo"]),
      );
      const awsOnly = entries.find((e) => e.id === "wp2shell-friday-night-patch");
      expect(
        awsOnly,
        "AWS 専用問題がカタログから消えている (#2926 の決定を覆している)",
      ).toBeDefined();
      expect(awsOnly?.localPlayable).toBe(false);
    });

    it("should not depend on the runtime field, which hello-multicloud does declare", () => {
      // `hello-multicloud` は runtime を持つが kind: "composite" (4 クラウドの実 deploy 定義)
      // で local/ を持たない。runtime の有無で判定するとこの 1 問を取りこぼす。
      const tree = {
        [CHALLENGES]: {
          "hello-multicloud": metadata("hello-multicloud", {
            runtime: { provider: "aws", engine: "cloudformation" },
          }),
        },
      };
      const { entries } = loadProblemCatalogEntries([CHALLENGES], fsWithLocalDirs(tree, []));
      expect(entries[0]?.localPlayable).toBe(false);
    });
  });

  it("should include problems that are not locally playable (the course track needs them)", () => {
    // An AWS-only problem has no local/docker-compose.yml, so `listLocalPlayProblems`
    // drops it. The learning path must still show it or everything ahead of the
    // learner's current position disappears from the track (#2926).
    const { entries } = loadProblemCatalogEntries(
      [CHALLENGES],
      fakeFs({
        [CHALLENGES]: {
          "aws-only": metadata("aws-only", { runtime: { provider: "aws" } }),
        },
      }),
    );
    expect(entries.map((e) => e.id)).toEqual(["aws-only"]);
  });

  it("should apply the same fairness projection as the build-time catalog", () => {
    const { entries } = loadProblemCatalogEntries(
      [CHALLENGES],
      fakeFs({
        [CHALLENGES]: {
          demo: metadata("demo", {
            phases: [
              { name: "public", afterMinutes: 5, publicHint: true },
              { name: "secret", afterMinutes: 9, effect: { x: 1 } },
            ],
          }),
        },
      }),
    );
    const [entry] = entries;
    expect(JSON.stringify(entry)).not.toContain("SECRET scoring rules");
    expect(entry).not.toHaveProperty("description");
    expect(entry.phases.map((p) => p.name)).toEqual(["public"]);
  });

  it("should report an unparseable metadata.json instead of dropping it in silence", () => {
    const { entries, skipped } = loadProblemCatalogEntries(
      [CHALLENGES],
      fakeFs({
        [CHALLENGES]: { good: metadata("good"), broken: "{ not json" },
      }),
    );
    expect(entries.map((e) => e.id)).toEqual(["good"]);
    expect(skipped.map((s) => s.problemId)).toEqual(["broken"]);
    expect(skipped[0].reason).toBeTruthy();
  });

  it("should report a metadata.json with no usable id rather than emitting a keyless entry", () => {
    const { entries, skipped } = loadProblemCatalogEntries(
      [CHALLENGES],
      fakeFs({ [CHALLENGES]: { nameless: JSON.stringify({ name: "no id here" }) } }),
    );
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ problemId: "nameless", reason: "metadata.json has no usable id" }]);
  });

  it("should skip a directory that carries no metadata.json at all", () => {
    const fs = fakeFs({ [CHALLENGES]: { real: metadata("real") } });
    const withStrayDir = { ...fs, readDirNames: () => ["real", "not-a-problem"] };
    const { entries, skipped } = loadProblemCatalogEntries([CHALLENGES], withStrayDir);
    expect(entries.map((e) => e.id)).toEqual(["real"]);
    expect(skipped).toEqual([]);
  });
});

/**
 * [#2925 / #2926] The build-time catalog has a post-build guard that greps the produced
 * bundle for catalog writeup strings (`apps/participant-portal` build script). The runtime
 * catalog needs the equivalent, because it is a second way the same metadata can reach a
 * participant — and the projection is the only thing standing between `metadata.json` and
 * the wire. Run against the real catalog rather than a fixture: a fixture only proves the
 * projection drops the fields the fixture happened to declare.
 */
/** True when `value` from a raw metadata.json can be found in `payload`. */
function isLeaked(value: unknown, payload: string, asProse: boolean): boolean {
  if (asProse) return typeof value === "string" && value.length > 30 && payload.includes(value);
  return value !== undefined && payload.includes(JSON.stringify(value));
}

/** Fields whose raw value must never appear in a problem's own projected entry, and how to look for each. */
const FORBIDDEN_FIELDS = [
  // Long prose: substring match, guarded by a length floor so a short shared phrase
  // (e.g. a one-word description) cannot produce a false positive.
  { fields: ["description", "writeup", "writeupI18n", "cfnTemplate"], asProse: true },
  // Structured authoring data: exact serialized match.
  { fields: ["scoring", "cfnParameters"], asProse: false },
] as const;

/**
 * `${entry.id}.${field}` for every forbidden field of `raw` (that entry's own
 * raw metadata.json) found inside `entry`'s OWN serialized projection --
 * never against any other problem's entry, or the combined multi-problem
 * catalog payload. Scoping matters: a forbidden value only actually "leaks"
 * if it appears in the entry it was supposed to be redacted FROM. Checking a
 * combined payload instead is both over-broad (a short/generic forbidden
 * value -- `cfnParameters: {}` serializes to the 2-character string `"{}"` --
 * trivially collides with unrelated prose anywhere else in a 100+-problem
 * catalog, e.g. another problem's own instructions quoting an empty dict
 * literal) and detects nothing extra: a real leak of problem A's redacted
 * field always shows up inside problem A's own entry too.
 */
function leaksForEntry(
  entry: Record<string, unknown> & { id: string },
  raw: Record<string, unknown>,
): string[] {
  const ownPayload = JSON.stringify(entry);
  return FORBIDDEN_FIELDS.flatMap(({ fields, asProse }) =>
    fields
      .filter((field) => isLeaked(raw[field], ownPayload, asProse))
      .map((f) => `${entry.id}.${f}`),
  );
}

describe("leaksForEntry -- scoped-to-own-entry leak detection [platform fix landed alongside TenkaCloudChallenge#638]", () => {
  // Focused, catalog-independent unit coverage for the scoping fix itself --
  // the integration test below (against the real catalog) can only prove
  // "no leak currently exists", never "a real leak would still be caught" or
  // "this exact false-positive class can't recur", since neither scenario
  // is something the real catalog is guaranteed to contain.
  it("still catches a genuine self-leak: the forbidden field appears inside its OWN entry", () => {
    const raw = { scoring: { rubric: "internal grading logic", points: 999 } };
    // Simulates a projection bug that forgot to redact `scoring` onto the
    // wire entry itself.
    const leakyEntry = { id: "fake-problem", scoring: raw.scoring };
    expect(leaksForEntry(leakyEntry, raw)).toEqual(["fake-problem.scoring"]);
  });

  it("does NOT flag a coincidental match against an UNRELATED problem's entry (the exact false positive this scoping fixes)", () => {
    // `cfnParameters: {}` serializes to the trivially-collidable string
    // `"{}"`. `otherProblemsPayload` simulates the REST of a large combined
    // catalog containing an unrelated problem whose prose happens to quote
    // an empty dict literal -- exactly what tripped this check against the
    // real catalog before this fix (`hello-world-battle` /
    // `microservice-migration-battle`, both legitimately `cfnParameters: {}`,
    // colliding with an unrelated Advanced Cryptography challenge's
    // "見つからなければ空の辞書 `{}`" prose).
    const raw = { cfnParameters: {} };
    const ownEntry = { id: "hello-world-battle", cfnParameters: undefined }; // correctly redacted off the wire
    const otherProblemsPayload =
      '[{"id":"unrelated","description":"returns an empty dict `{}` if not found"}]';

    expect(leaksForEntry(ownEntry, raw)).toEqual([]);
    // Confirms this is a real collision (i.e. the test above isn't passing
    // vacuously) -- `isLeaked` alone, against the WRONG scope, still finds
    // it. Only the CALLER's scoping (using `ownEntry`, not a combined
    // multi-problem payload) is what fixes this.
    expect(isLeaked(raw.cfnParameters, otherProblemsPayload, false)).toBe(true);
  });
});

describe("runtime catalog wire payload carries nothing participant-hostile (#2925 / #2926)", () => {
  const REPO_ROOTS = problemSearchRoots(join(__dirname, "..", "..", ".."));
  const { entries } = loadProblemCatalogEntries(REPO_ROOTS);

  /** Every key the participant-facing catalog entry is allowed to carry. */
  const ALLOWED_KEYS = new Set([
    "category",
    "courseAlignment",
    "dashboardSlots",
    "difficulty",
    "disruptions",
    "endpoints",
    "estimatedDuration",
    "graphNodes",
    "graphRelations",
    "i18n",
    "id",
    "instructions",
    "interTeamCoordination",
    "learningGoals",
    // [Challenge #402] 「この問題は local play では起動できない」。参加者に見せてよいどころか、
    // 見せないと開いてから行き止まりに当たるまで分からない情報なので allowlist に入れる。
    "localPlayable",
    "name",
    "phases",
    "runtime",
    "shortDescription",
    "status",
    "tags",
    "track",
    "visibility",
  ]);

  it("should have loaded the real catalog (otherwise the assertions below are vacuous)", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("should carry no key outside the participant-facing allowlist", () => {
    const seen = new Set(entries.flatMap((entry) => Object.keys(entry)));
    expect([...seen].filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);
  });

  /** The raw metadata.json behind a projected entry. */
  function rawMetadataOf(problemId: string): Record<string, unknown> {
    const dir = resolveProblemDir(REPO_ROOTS, problemId);
    return JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
  }

  it("should never carry a problem's writeup, template, or scoring rules", () => {
    // See `leaksForEntry`'s doc comment above for why this is scoped to each
    // problem's own entry rather than the combined multi-problem payload.
    const leaks = entries.flatMap((entry) => leaksForEntry(entry, rawMetadataOf(entry.id)));
    expect(leaks).toEqual([]);
  });
});
