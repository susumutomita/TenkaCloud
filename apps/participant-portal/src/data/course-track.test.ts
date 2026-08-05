import { describe, expect, it } from "vitest";
import {
  buildCourseAlignmentTracks,
  buildCourseTracks,
  type CourseProblemView,
  evaluatePrerequisites,
  type ProblemProgress,
  recommendNext,
  recommendNextInCourseOrder,
  resolvePrerequisiteProblemIds,
  toProblemProgress,
} from "./course-track";
import type { ProblemCatalogEntry } from "./problems";

/**
 * Issue #2786: track view の組み立て契約。
 *
 * ここで守りたいのは 2 つ。第一に、track を宣言しない既存問題が 1 件も混ざらないこと。
 * 第二に、壊れた catalog (cycle / 欠損 node / 部分的な track) で participant の画面が
 * 落ちたり、理由なく問題が塞がれたりしないこと。
 */

function entry(overrides: Partial<ProblemCatalogEntry> = {}): ProblemCatalogEntry {
  return {
    id: "p1",
    name: "問題 1",
    category: "Challenge",
    status: "ready",
    visibility: "public",
    difficulty: 2,
    estimatedDuration: "30 分",
    shortDescription: "短い説明",
    learningGoals: ["目標"],
    tags: [],
    endpoints: [],
    phases: [],
    disruptions: [],
    runtime: { provider: "docker", engine: "compose" },
    graphNodes: [],
    graphRelations: [],
    ...overrides,
  } as ProblemCatalogEntry;
}

function tracked(
  id: string,
  order: number,
  chapter: string,
  extra: Partial<ProblemCatalogEntry> = {},
): ProblemCatalogEntry {
  return entry({
    id,
    name: id,
    track: { id: "ac26", order, chapter },
    ...extra,
  });
}

function progress(
  problemId: string,
  solved: boolean,
  solvedCheckpoints = 0,
  total = 0,
): ProblemProgress {
  return { problemId, solved, solvedCheckpoints, totalCheckpoints: total };
}

function alignment(role: string, week = 1) {
  return {
    courseAlignment: {
      courseId: "advanced-cryptography-program",
      edition: "2026",
      week,
      role,
      sources: [],
    },
  } as Partial<ProblemCatalogEntry>;
}

describe("resolvePrerequisiteProblemIds", () => {
  it("should resolve a requires edge that names a problem directly", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    expect(resolvePrerequisiteProblemIds(b, [a, b]).resolved).toEqual(["a"]);
  });

  it("should resolve a concept prerequisite through the problem that teaches it", () => {
    const teacher = tracked("teacher", 10, "W1", {
      graphRelations: [{ type: "covers", source: "problem.teacher", target: "concept.x" }],
    });
    const learner = tracked("learner", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.learner", target: "concept.x" }],
    });
    expect(resolvePrerequisiteProblemIds(learner, [teacher, learner]).resolved).toEqual([
      "teacher",
    ]);
  });

  it("should report a concept that no problem provides as unresolved", () => {
    const orphan = tracked("orphan", 10, "W1", {
      graphRelations: [{ type: "requires", source: "problem.orphan", target: "concept.nobody" }],
    });
    const result = resolvePrerequisiteProblemIds(orphan, [orphan]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolvedTargets).toEqual(["concept.nobody"]);
  });

  it("should not treat a problem as its own prerequisite", () => {
    // 自分が teaches する concept を自分で requires する metadata は実在する
    // (= 「この問題で扱う概念」を両方向で書いてしまうケース)。
    const selfish = tracked("selfish", 10, "W1", {
      graphRelations: [
        { type: "covers", source: "problem.selfish", target: "concept.x" },
        { type: "requires", source: "problem.selfish", target: "concept.x" },
      ],
    });
    const result = resolvePrerequisiteProblemIds(selfish, [selfish]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolvedTargets).toEqual(["concept.x"]);
  });

  it("should ignore relation types that are not requires", () => {
    const e = tracked("e", 10, "W1", {
      graphRelations: [
        { type: "teaches", source: "problem.e", target: "lo.e.x" },
        { type: "covers", source: "problem.e", target: "concept.y" },
      ],
    });
    expect(resolvePrerequisiteProblemIds(e, [e]).resolved).toEqual([]);
  });
});

describe("evaluatePrerequisites", () => {
  it("should report met when a problem declares no prerequisite", () => {
    const a = tracked("a", 10, "W1");
    expect(evaluatePrerequisites(a, [a], new Map())).toEqual({ state: "met", unmet: [] });
  });

  it("should report met once every prerequisite is solved", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    const map = new Map([["a", progress("a", true)]]);
    expect(evaluatePrerequisites(b, [a, b], map)).toEqual({ state: "met", unmet: [] });
  });

  it("should name the unsolved prerequisites rather than only reporting unmet", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    expect(evaluatePrerequisites(b, [a, b], new Map())).toEqual({ state: "unmet", unmet: ["a"] });
  });

  it("should fail soft to unknown when a prerequisite is missing from the catalog", () => {
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.gone" }],
    });
    expect(evaluatePrerequisites(b, [b], new Map()).state).toBe("unknown");
  });

  it("should fail soft to unknown on a requires cycle instead of throwing", () => {
    // 著者側のバグだが、participant の画面が落ちる理由にはならない。
    const a = tracked("a", 10, "W1", {
      graphRelations: [{ type: "requires", source: "problem.a", target: "problem.b" }],
    });
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    expect(evaluatePrerequisites(a, [a, b], new Map()).state).toBe("unknown");
    expect(evaluatePrerequisites(b, [a, b], new Map()).state).toBe("unknown");
  });

  it("should fail soft to unknown on a longer cycle", () => {
    const chain = ["a", "b", "c"].map((id, index, all) =>
      tracked(id, (index + 1) * 10, "W1", {
        graphRelations: [
          { type: "requires", source: `problem.${id}`, target: `problem.${all[(index + 1) % 3]}` },
        ],
      }),
    );
    expect(evaluatePrerequisites(chain[0] as ProblemCatalogEntry, chain, new Map()).state).toBe(
      "unknown",
    );
  });

  it("should stay met for a long acyclic chain", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    const c = tracked("c", 30, "W1", {
      graphRelations: [{ type: "requires", source: "problem.c", target: "problem.b" }],
    });
    const map = new Map([
      ["a", progress("a", true)],
      ["b", progress("b", true)],
    ]);
    expect(evaluatePrerequisites(c, [a, b, c], map)).toEqual({ state: "met", unmet: [] });
  });
});

describe("recommendNext", () => {
  function view(overrides: Partial<CourseProblemView>): CourseProblemView {
    return {
      problemId: "x",
      name: "x",
      chapter: "W1",
      order: 10,
      difficulty: 1,
      estimatedDuration: "10 分",
      learningGoals: [],
      progress: progress("x", false),
      prerequisiteState: "met",
      unmetPrerequisites: [],
      sources: [],
      ...overrides,
    } as CourseProblemView;
  }

  it("should return nothing when everything is solved", () => {
    expect(recommendNext([view({ progress: progress("x", true) })])).toBeUndefined();
  });

  it("should prefer an unsolved diagnostic over an earlier mechanism", () => {
    const mechanism = view({ problemId: "m", order: 10, role: "mechanism" });
    const diagnostic = view({ problemId: "d", order: 99, role: "diagnostic" });
    expect(recommendNext([mechanism, diagnostic])?.problemId).toBe("d");
  });

  it("should follow track order among equal candidates", () => {
    const later = view({ problemId: "later", order: 30 });
    const earlier = view({ problemId: "earlier", order: 20 });
    expect(recommendNext([later, earlier])?.problemId).toBe("earlier");
  });

  it("should skip a problem whose prerequisites are unmet", () => {
    const blocked = view({ problemId: "blocked", order: 10, prerequisiteState: "unmet" });
    const open = view({ problemId: "open", order: 20 });
    expect(recommendNext([blocked, open])?.problemId).toBe("open");
  });

  it("should still recommend a problem whose prerequisites could not be judged", () => {
    // unknown で塞ぐと、著者側の graph バグが participant の進行不能に化ける。
    const unknown = view({ problemId: "u", order: 10, prerequisiteState: "unknown" });
    expect(recommendNext([unknown])?.problemId).toBe("u");
  });

  it("should hold synthesis back until nothing else is startable", () => {
    const synthesis = view({ problemId: "s", order: 10, role: "synthesis" });
    const transfer = view({ problemId: "t", order: 20, role: "transfer" });
    expect(recommendNext([synthesis, transfer])?.problemId).toBe("t");
  });

  it("should recommend synthesis once it is the only thing left", () => {
    const synthesis = view({ problemId: "s", order: 10, role: "synthesis" });
    expect(recommendNext([synthesis])?.problemId).toBe("s");
  });

  it("should return nothing when every unsolved problem is blocked", () => {
    const blocked = view({ problemId: "b", prerequisiteState: "unmet" });
    expect(recommendNext([blocked])).toBeUndefined();
  });
});

describe("recommendNextInCourseOrder (#2882)", () => {
  function view(overrides: Partial<CourseProblemView>): CourseProblemView {
    return {
      problemId: "x",
      name: "x",
      chapter: "Week 1",
      order: 10,
      difficulty: 1,
      estimatedDuration: "10 分",
      learningGoals: [],
      progress: progress("x", false),
      prerequisiteState: "met",
      unmetPrerequisites: [],
      sources: [],
      ...overrides,
    } as CourseProblemView;
  }

  it("should keep the syllabus order instead of postponing an earlier synthesis", () => {
    const synthesis = view({ problemId: "week-2-synthesis", order: 250, role: "synthesis" });
    const later = view({ problemId: "week-3-mechanism", order: 310, role: "mechanism" });
    expect(recommendNextInCourseOrder([later, synthesis])?.problemId).toBe("week-2-synthesis");
  });

  it("should skip an unmet prerequisite without locking the rest of the course", () => {
    const blocked = view({ problemId: "blocked", order: 10, prerequisiteState: "unmet" });
    const open = view({ problemId: "open", order: 20 });
    expect(recommendNextInCourseOrder([blocked, open])?.problemId).toBe("open");
  });

  it("should break an equal syllabus order by problem id", () => {
    const second = view({ problemId: "b", order: 10 });
    const first = view({ problemId: "a", order: 10 });
    expect(recommendNextInCourseOrder([second, first])?.problemId).toBe("a");
  });
});

describe("buildCourseTracks", () => {
  it("should exclude every problem that declares no track", () => {
    const untracked = entry({ id: "legacy" });
    const inTrack = tracked("a", 10, "W1");
    const tracks = buildCourseTracks([untracked, inTrack], []);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.chapters.flatMap((c) => c.problems.map((p) => p.problemId))).toEqual(["a"]);
  });

  it("should return no tracks at all when the catalog has none", () => {
    expect(buildCourseTracks([entry({ id: "legacy" })], [])).toEqual([]);
  });

  it("should order chapters by their lowest problem order, not by chapter name", () => {
    // 文字列順だと "Week 10" が "Week 2" より前に来る。
    const w2 = tracked("w2", 200, "Week 2");
    const w10 = tracked("w10", 1000, "Week 10");
    const tracks = buildCourseTracks([w10, w2], []);
    expect(tracks[0]?.chapters.map((c) => c.chapter)).toEqual(["Week 2", "Week 10"]);
  });

  it("should order problems inside a chapter by track order", () => {
    const second = tracked("second", 20, "W1");
    const first = tracked("first", 10, "W1");
    const tracks = buildCourseTracks([second, first], []);
    expect(tracks[0]?.chapters[0]?.problems.map((p) => p.problemId)).toEqual(["first", "second"]);
  });

  it("should break an order tie deterministically by problem id", () => {
    const b = tracked("b", 10, "W1");
    const a = tracked("a", 10, "W1");
    const tracks = buildCourseTracks([b, a], []);
    expect(tracks[0]?.chapters[0]?.problems.map((p) => p.problemId)).toEqual(["a", "b"]);
  });

  it("should split multiple tracks and sort them by track id", () => {
    const second = entry({ id: "z", track: { id: "zzz", order: 10, chapter: "C" } });
    const first = tracked("a", 10, "W1");
    expect(buildCourseTracks([second, first], []).map((t) => t.trackId)).toEqual(["ac26", "zzz"]);
  });

  it("should total problems and checkpoints across the track", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1");
    const tracks = buildCourseTracks(
      [a, b],
      [progress("a", true, 4, 4), progress("b", false, 1, 3)],
    );
    expect(tracks[0]).toMatchObject({
      totalProblems: 2,
      solvedProblems: 1,
      totalCheckpoints: 7,
      solvedCheckpoints: 5,
    });
  });

  it("should treat a problem with no progress entry as unstarted rather than dropping it", () => {
    const tracks = buildCourseTracks([tracked("a", 10, "W1")], []);
    const view = tracks[0]?.chapters[0]?.problems[0];
    expect(view?.progress).toMatchObject({ problemId: "a", solved: false, totalCheckpoints: 0 });
  });

  it("should carry the course week and role through to the view", () => {
    const a = tracked("a", 10, "W1", alignment("mechanism", 3));
    const view = buildCourseTracks([a], [])[0]?.chapters[0]?.problems[0];
    expect(view).toMatchObject({ week: 3, role: "mechanism" });
  });

  it("should omit week and role for a tracked problem with no course alignment", () => {
    const view = buildCourseTracks([tracked("a", 10, "W1")], [])[0]?.chapters[0]?.problems[0];
    expect(view?.week).toBeUndefined();
    expect(view?.role).toBeUndefined();
  });

  it("should take the edition from whichever problem declares an alignment", () => {
    const plain = tracked("a", 10, "W1");
    const aligned = tracked("b", 20, "W1", alignment("mechanism"));
    expect(buildCourseTracks([plain, aligned], [])[0]?.edition).toBe("2026");
  });

  it("should leave edition unset when no problem in the track is course-aligned", () => {
    expect(buildCourseTracks([tracked("a", 10, "W1")], [])[0]?.edition).toBeUndefined();
  });

  it("should recommend the first startable problem for a fresh team", () => {
    const a = tracked("a", 10, "W1", alignment("diagnostic"));
    const b = tracked("b", 20, "W1", alignment("mechanism"));
    expect(buildCourseTracks([a, b], [])[0]?.recommendedNext?.problemId).toBe("a");
  });

  it("should move the recommendation on once a prerequisite is solved", () => {
    const a = tracked("a", 10, "W1", alignment("diagnostic"));
    const b = tracked("b", 20, "W1", {
      ...alignment("mechanism"),
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    const before = buildCourseTracks([a, b], []);
    expect(before[0]?.recommendedNext?.problemId).toBe("a");
    const after = buildCourseTracks([a, b], [progress("a", true)]);
    expect(after[0]?.recommendedNext?.problemId).toBe("b");
  });

  it("should stop recommending once the whole track is solved", () => {
    const a = tracked("a", 10, "W1");
    expect(buildCourseTracks([a], [progress("a", true)])[0]?.recommendedNext).toBeUndefined();
  });

  it("should expose the unmet prerequisite on the blocked problem itself", () => {
    const a = tracked("a", 10, "W1");
    const b = tracked("b", 20, "W1", {
      graphRelations: [{ type: "requires", source: "problem.b", target: "problem.a" }],
    });
    const blocked = buildCourseTracks([a, b], [])[0]?.chapters[0]?.problems.find(
      (p) => p.problemId === "b",
    );
    expect(blocked).toMatchObject({ prerequisiteState: "unmet", unmetPrerequisites: ["a"] });
  });

  it("should surface the pinned source so a link can point at a fixed commit", () => {
    const a = tracked("a", 10, "W1", {
      courseAlignment: {
        courseId: "c",
        edition: "2026",
        week: 1,
        role: "mechanism",
        sources: [
          { repository: "org/repo", ref: "a".repeat(40), path: "week1/README.md", kind: "lecture" },
        ],
      },
    });
    const view = buildCourseTracks([a], [])[0]?.chapters[0]?.problems[0];
    expect(view?.sources).toEqual([
      { repository: "org/repo", ref: "a".repeat(40), path: "week1/README.md" },
    ]);
  });
});

describe("buildCourseAlignmentTracks (#2882)", () => {
  it("should group aligned problems by course and into seven week-style chapters", () => {
    const catalog = Array.from({ length: 7 }, (_, index) =>
      tracked(`week-${index + 1}`, (index + 1) * 100, `Fine-grained chapter ${index + 1}`, {
        ...alignment("mechanism", index + 1),
      }),
    );
    const tracks = buildCourseAlignmentTracks(catalog, []);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.trackId).toBe("advanced-cryptography-program");
    expect(tracks[0]?.chapters.map((chapter) => chapter.chapter)).toEqual([
      "Week 1",
      "Week 2",
      "Week 3",
      "Week 4",
      "Week 5",
      "Week 6",
      "Week 7",
    ]);
  });

  it("should exclude unaligned problems even when they declare a generic track", () => {
    const aligned = tracked("aligned", 10, "Detailed chapter", alignment("mechanism"));
    const unaligned = tracked("unaligned", 20, "Other track");
    const ids = buildCourseAlignmentTracks(
      [aligned, unaligned],
      [progress("aligned", false), progress("unaligned", false)],
    ).flatMap((track) =>
      track.chapters.flatMap((chapter) => chapter.problems.map((problem) => problem.problemId)),
    );

    expect(ids).toEqual(["aligned"]);
  });

  it("should still order an aligned problem that has no generic track", () => {
    const alignedWithoutTrack = entry({ id: "aligned-only", ...alignment("diagnostic", 3) });
    const track = buildCourseAlignmentTracks([alignedWithoutTrack], [])[0];
    expect(track?.chapters[0]?.chapter).toBe("Week 3");
    expect(track?.recommendedNext?.problemId).toBe("aligned-only");
  });
});

describe("toProblemProgress", () => {
  it("should count solved checkpoints for a multi-verify problem", () => {
    const [progress] = toProblemProgress([
      {
        problemId: "p",
        scoring: { flags: [{ solved: true }, { solved: false }, { solved: true }] },
      },
    ]);
    expect(progress).toEqual({
      problemId: "p",
      solved: false,
      solvedCheckpoints: 2,
      totalCheckpoints: 3,
    });
  });

  it("should mark a multi-verify problem solved only when every checkpoint is closed", () => {
    const [progress] = toProblemProgress([
      { problemId: "p", scoring: { flags: [{ solved: true }, { solved: true }] } },
    ]);
    expect(progress).toMatchObject({ solved: true, solvedCheckpoints: 2, totalCheckpoints: 2 });
  });

  it("should use flagSubmitted for a single-flag problem and report no checkpoints", () => {
    // checkpoint の概念が無いので 0/0。 UI は 0/0 を「進捗バーなし」として扱う。
    const [progress] = toProblemProgress([{ problemId: "p", scoring: { flagSubmitted: true } }]);
    expect(progress).toEqual({
      problemId: "p",
      solved: true,
      solvedCheckpoints: 0,
      totalCheckpoints: 0,
    });
  });

  it("should treat a problem with no scoring info as unstarted", () => {
    expect(toProblemProgress([{ problemId: "p" }])[0]).toMatchObject({
      solved: false,
      totalCheckpoints: 0,
    });
  });

  it("should treat an empty flags array as a single-flag problem", () => {
    // deploy 直後に flags が空で返ることがある。 その一瞬を「0/0 達成 = 完了」にしない。
    const [progress] = toProblemProgress([{ problemId: "p", scoring: { flags: [] } }]);
    expect(progress).toMatchObject({ solved: false, totalCheckpoints: 0 });
  });
});
