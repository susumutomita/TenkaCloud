import { describe, expect, it } from "vitest";
import {
  buildCourseAlignmentTracks,
  buildCourseTracks,
  type CourseProblemView,
  type CourseTrackView,
  isRecommendableTrack,
  type ProblemProgress,
  recommendedNextAcrossTracks,
  recommendNext,
  recommendNextInCourseOrder,
  TRACKS_EXCLUDED_FROM_DEFAULT_RECOMMENDATION,
  toProblemProgress,
} from "./course-track";
import type { ProblemCatalogEntry } from "./problems";

/**
 * Issue #2786: track view の組み立て契約。
 *
 * ここで守りたいのは 2 つ。第一に、track を宣言しない既存問題が 1 件も混ざらないこと。
 * 第二に、`track.order` に従って deterministic に推薦されること。
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

  it("should hold synthesis back until nothing else is startable", () => {
    const synthesis = view({ problemId: "s", order: 10, role: "synthesis" });
    const transfer = view({ problemId: "t", order: 20, role: "transfer" });
    expect(recommendNext([synthesis, transfer])?.problemId).toBe("t");
  });

  it("should recommend synthesis once it is the only thing left", () => {
    const synthesis = view({ problemId: "s", order: 10, role: "synthesis" });
    expect(recommendNext([synthesis])?.problemId).toBe("s");
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
      sources: [],
      ...overrides,
    } as CourseProblemView;
  }

  it("should keep the syllabus order instead of postponing an earlier synthesis", () => {
    const synthesis = view({ problemId: "week-2-synthesis", order: 250, role: "synthesis" });
    const later = view({ problemId: "week-3-mechanism", order: 310, role: "mechanism" });
    expect(recommendNextInCourseOrder([later, synthesis])?.problemId).toBe("week-2-synthesis");
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

  // AC26 では `track.chapter` が 1 問ごとの小節で、31 問が 26 章に散っていた。折りたたみが
  // 1 問ずつ並ぶだけで「いま何週目か」が掴めないので、alignment を持つ問題は週で束ねる。
  it("should group course-aligned problems by week instead of their per-problem chapter", () => {
    const w1a = tracked("w1a", 10, "AC26 §1.1 predict", alignment("mechanism", 1));
    const w1b = tracked("w1b", 20, "AC26 §1.2 constrain", alignment("diagnostic", 1));
    const w2 = tracked("w2", 30, "AC26 §2.1 shares", alignment("mechanism", 2));

    const chapters = buildCourseTracks([w1a, w1b, w2], [])[0]?.chapters ?? [];

    expect(chapters.map((chapter) => chapter.chapter)).toEqual(["Week 1", "Week 2"]);
    expect(chapters[0]?.problems.map((p) => p.problemId)).toEqual(["w1a", "w1b"]);
  });

  // alignment を持たない track (ipa-web-security 等) は数問しかなく、`IPA §1.5 XSS` の
  // ような小節見出しがそのまま索引として働くので、従来どおりの章立てを残す。
  it("should keep the declared chapter for a track with no course alignment", () => {
    const xss = tracked("xss", 10, "IPA §1.5 XSS");
    const csrf = tracked("csrf", 20, "IPA §1.6 CSRF");

    const chapters = buildCourseTracks([xss, csrf], [])[0]?.chapters ?? [];

    expect(chapters.map((chapter) => chapter.chapter)).toEqual(["IPA §1.5 XSS", "IPA §1.6 CSRF"]);
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

  it("should move the recommendation on once the earlier problem is solved", () => {
    const a = tracked("a", 10, "W1", alignment("diagnostic"));
    const b = tracked("b", 20, "W1", alignment("mechanism"));
    const before = buildCourseTracks([a, b], []);
    expect(before[0]?.recommendedNext?.problemId).toBe("a");
    const after = buildCourseTracks([a, b], [progress("a", true)]);
    expect(after[0]?.recommendedNext?.problemId).toBe("b");
  });

  it("should stop recommending once the whole track is solved", () => {
    const a = tracked("a", 10, "W1");
    expect(buildCourseTracks([a], [progress("a", true)])[0]?.recommendedNext).toBeUndefined();
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

/**
 * Issue #2965: 「次にやること」がどのトラックから出るかは、track id の文字列順で決まっていた。
 *
 * `assembleCourseTracks` が id を `localeCompare` で並べ、Home がその先頭を取っていたため、
 * `advanced-cryptography-2026` が `automotive-security` にも `ipa-web-security` にも辞書順で
 * 勝つ。結果、1 問解いた直後の初学者に大学院レベルの法演算の問題が出ていた。学習設計上の
 * 意図ではなく、ソート順の副作用だった。
 */
describe("recommendedNextAcrossTracks (issue #2965)", () => {
  function trackView(trackId: string, problemId: string): CourseTrackView {
    const next = {
      problemId,
      name: problemId,
      chapter: "Week 1",
      order: 10,
      solved: false,
      locked: false,
      solvedCheckpoints: 0,
      totalCheckpoints: 1,
      prerequisiteProblemIds: [],
    } as unknown as CourseProblemView;
    return {
      trackId,
      chapters: [{ chapter: "Week 1", problems: [next] }],
      totalProblems: 1,
      solvedProblems: 0,
      totalCheckpoints: 1,
      solvedCheckpoints: 0,
      recommendedNext: next,
    };
  }

  it("should not let the lexically first track win", () => {
    // 起票時の実データそのもの。辞書順なら advanced-cryptography-2026 が勝つ。
    const tracks = [
      trackView("advanced-cryptography-2026", "ac26-bridge-experiment"),
      trackView("automotive-security", "auto-1"),
      trackView("ipa-web-security", "ipa-1"),
    ];
    expect(recommendedNextAcrossTracks(tracks)?.problemId).toBe("ipa-1");
  });

  it("should send a new player down the StackStack route (Challenge #397)", () => {
    // プラットフォームの目標が「未経験の人が StackStack を解けるようになる」なので、
    // StackStack ルートが他のどのトラックより先に来る。辞書順なら
    // advanced-cryptography-2026 が、優先リストが古ければ ipa-web-security が勝つ。
    const tracks = [
      trackView("advanced-cryptography-2026", "ac26-bridge-experiment"),
      trackView("ipa-web-security", "ipa-1"),
      trackView("stackstack-route", "stackstack-onboarding"),
    ];
    expect(recommendedNextAcrossTracks(tracks)?.problemId).toBe("stackstack-onboarding");
  });

  it("should not depend on the order the tracks arrive in", () => {
    // 入力順を変えても結果が変わらないこと。ここが揺れると「たまたま今は正しい」になる。
    const forward = [
      trackView("ipa-web-security", "ipa-1"),
      trackView("automotive-security", "auto-1"),
    ];
    const reversed = [...forward].reverse();
    expect(recommendedNextAcrossTracks(forward)?.problemId).toBe("ipa-1");
    expect(recommendedNextAcrossTracks(reversed)?.problemId).toBe("ipa-1");
  });

  it("should keep an excluded track out of the default recommendation", () => {
    // 除外したトラックしか候補が無ければ、何も勧めない。無関係な問題を出すより無言が正しい。
    const tracks = [trackView("advanced-cryptography-2026", "ac26-bridge-experiment")];
    expect(recommendedNextAcrossTracks(tracks)).toBeUndefined();
  });

  it("should keep an excluded track reachable rather than hidden", () => {
    // 「既定導線から外す」であって「消す」ではない。track 画面の母数には残る。
    expect(isRecommendableTrack("advanced-cryptography-2026")).toBe(false);
    expect(TRACKS_EXCLUDED_FROM_DEFAULT_RECOMMENDATION.has("advanced-cryptography-2026")).toBe(
      true,
    );
    expect(isRecommendableTrack("ipa-web-security")).toBe(true);
  });

  it("should fall back to a non-prioritised track when the prioritised ones have nothing left", () => {
    const finished = { ...trackView("ipa-web-security", "ipa-1"), recommendedNext: undefined };
    const other = trackView("zz-late-track", "zz-1");
    expect(recommendedNextAcrossTracks([finished, other])?.problemId).toBe("zz-1");
  });
});
