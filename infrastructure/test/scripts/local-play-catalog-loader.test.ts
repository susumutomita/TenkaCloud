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
/** True when `value` from a raw metadata.json can be found in the projected payload. */
function isLeaked(value: unknown, payload: string, asProse: boolean): boolean {
  if (asProse) return typeof value === "string" && value.length > 30 && payload.includes(value);
  return value !== undefined && payload.includes(JSON.stringify(value));
}

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

  /** Fields whose raw value must never appear in the payload, and how to look for each. */
  const FORBIDDEN = [
    // Long prose: substring match, guarded by a length floor so a short shared phrase
    // (e.g. a one-word description) cannot produce a false positive.
    { fields: ["description", "writeup", "writeupI18n", "cfnTemplate"], asProse: true },
    // Structured authoring data: exact serialized match.
    { fields: ["scoring", "cfnParameters"], asProse: false },
  ] as const;

  it("should never carry a problem's writeup, template, or scoring rules", () => {
    const payload = JSON.stringify(entries);
    const leaks = entries.flatMap((entry) => {
      const raw = rawMetadataOf(entry.id);
      return FORBIDDEN.flatMap(({ fields, asProse }) =>
        fields
          .filter((field) => isLeaked(raw[field], payload, asProse))
          .map((f) => `${entry.id}.${f}`),
      );
    });
    expect(leaks).toEqual([]);
  });
});
