import { describe, expect, it } from "bun:test";
import {
  buildRecordedFilterGraph,
  RECORDED_LITE_EDITS,
  recordedChapterStartS,
  recordedEditDurationS,
  selectRecordedLiteEdits,
} from "./render-recorded-lite";

describe("recorded TenkaCloud Lite video edits", () => {
  it("should produce separate deploy and cleanup assets from opposite sides of the source split", () => {
    expect(RECORDED_LITE_EDITS.map((edit) => edit.problemId)).toEqual([
      "deploy-tenkacloud-lite",
      "cleanup-tenkacloud-lite",
    ]);
    const [deploy, cleanup] = RECORDED_LITE_EDITS;
    expect(deploy.sourceRanges.at(-1)?.endS).toBeLessThanOrEqual(500);
    const firstCleanupRecording = cleanup.sourceRanges.find((range) => !range.generated);
    expect(firstCleanupRecording?.startS).toBeGreaterThanOrEqual(500);
  });

  it("should keep both complete stories concise", () => {
    const [deploy, cleanup] = RECORDED_LITE_EDITS;
    expect(recordedEditDurationS(deploy)).toBeGreaterThanOrEqual(55);
    expect(recordedEditDurationS(deploy)).toBeLessThanOrEqual(82);
    expect(recordedEditDurationS(cleanup)).toBeGreaterThanOrEqual(40);
    expect(recordedEditDurationS(cleanup)).toBeLessThanOrEqual(50);
  });

  it("should tell the deploy story in causal order through play and scoring", () => {
    const deploy = RECORDED_LITE_EDITS[0];
    expect([...new Set(deploy.sourceRanges.map((range) => range.chapter))]).toEqual([
      "intro",
      "setup-explainer",
      "launcher",
      "deploy",
      "admin-sign-in",
      "trust-explainer",
      "competitor",
      "event-explainer",
      "event-create",
      "event-deploy",
      "participant",
      "play",
      "score",
    ]);
    expect(deploy.sourceRanges.at(-1)?.endS).toBeLessThanOrEqual(365);
  });

  it("should expose chapter starts from the actual edited ranges", () => {
    const deploy = RECORDED_LITE_EDITS[0];
    expect(recordedChapterStartS(deploy, "intro")).toBe(0);
    expect(recordedChapterStartS(deploy, "setup-explainer")).toBeCloseTo(8.7, 1);
    expect(recordedChapterStartS(deploy, "launcher")).toBeCloseTo(13.4, 1);
    expect(recordedChapterStartS(deploy, "deploy")).toBeCloseTo(19.8, 1);
    expect(recordedChapterStartS(deploy, "admin-sign-in")).toBeCloseTo(26.2, 1);
    expect(recordedChapterStartS(deploy, "event-deploy")).toBeGreaterThan(
      recordedChapterStartS(deploy, "event-create"),
    );

    const cleanup = RECORDED_LITE_EDITS[1];
    expect(recordedChapterStartS(cleanup, "cleanup-intro")).toBe(0);
    expect(recordedChapterStartS(cleanup, "cleanup-order")).toBeGreaterThan(
      recordedChapterStartS(cleanup, "cleanup-intro"),
    );
    expect(recordedChapterStartS(cleanup, "cleanup-action")).toBeGreaterThan(
      recordedChapterStartS(cleanup, "cleanup-order"),
    );
    expect(recordedChapterStartS(cleanup, "cleanup-launcher")).toBeGreaterThan(
      recordedChapterStartS(cleanup, "cleanup-wait"),
    );
    expect(recordedChapterStartS(cleanup, "cleanup-complete")).toBeGreaterThan(
      recordedChapterStartS(cleanup, "cleanup-launcher"),
    );
  });

  it("should avoid sub-second jump cuts and mark each edit with a deliberate crossfade", () => {
    const deploy = RECORDED_LITE_EDITS[0];
    for (const range of deploy.sourceRanges) {
      expect(range.endS - range.startS, range.chapter).toBeGreaterThanOrEqual(2);
    }
    const graph = buildRecordedFilterGraph(deploy.sourceRanges.slice(0, 3));
    expect(graph).toContain("xfade=transition=fade:duration=0.3");
    expect(buildRecordedFilterGraph(deploy.sourceRanges)).toContain(
      "xfade=transition=fadewhite:duration=0.3",
    );
  });

  it("should crop personal browser chrome and render a 720p fast-start-safe stream", () => {
    const graph = buildRecordedFilterGraph(RECORDED_LITE_EDITS[0].sourceRanges.slice(0, 3));
    expect(graph).toContain("crop=1472:940:312:140");
    expect(graph).toContain("scale=1280:720");
    expect(graph).toContain("setpts=(PTS-STARTPTS)/");
    expect(graph).toContain("anullsrc=r=48000:cl=stereo");
    expect(graph).toContain("[vout]");
  });

  it("should open with a generated definition card before showing AWS permissions", () => {
    const deploy = RECORDED_LITE_EDITS[0];
    expect(deploy.sourceRanges[0]).toMatchObject({ chapter: "intro", generated: "intro" });
    const graph = buildRecordedFilterGraph(deploy.sourceRanges.slice(0, 3));
    expect(graph).toContain("color=c=0x071426:s=1280x720:d=9.000");
    expect(graph.indexOf("color=c=0x071426")).toBeLessThan(graph.indexOf("[0:v]trim=start=7"));
  });

  it("should place a why slide immediately before each matching real screen group", () => {
    const chapters = RECORDED_LITE_EDITS[0].sourceRanges.map((range) => range.chapter);
    for (const [explainer, operation] of [
      ["setup-explainer", "launcher"],
      ["trust-explainer", "competitor"],
      ["event-explainer", "event-create"],
    ] as const) {
      const index = chapters.indexOf(explainer);
      expect(index, explainer).toBeGreaterThanOrEqual(0);
      expect(chapters[index + 1], explainer).toBe(operation);
      expect(RECORDED_LITE_EDITS[0].sourceRanges[index]?.generated).toBe("explainer");
      expect(RECORDED_LITE_EDITS[0].sourceRanges[index + 1]?.generated).toBeUndefined();
    }
  });

  it("should explain the cleanup flow and deletion order around the real AWS operations", () => {
    const cleanup = RECORDED_LITE_EDITS[1];
    expect([...new Set(cleanup.sourceRanges.map((range) => range.chapter))]).toEqual([
      "cleanup-intro",
      "cleanup-order",
      "cleanup-action",
      "cleanup-wait",
      "cleanup-launcher",
      "cleanup-complete",
    ]);
    expect(cleanup.sourceRanges[0]).toMatchObject({
      chapter: "cleanup-intro",
      generated: "intro",
    });
    expect(cleanup.sourceRanges[1]).toMatchObject({
      chapter: "cleanup-order",
      generated: "explainer",
    });
    expect(cleanup.sourceRanges[2]?.chapter).toBe("cleanup-action");
    expect(cleanup.sourceRanges[2]?.generated).toBeUndefined();
    expect(cleanup.sourceRanges.at(-1)).toMatchObject({
      chapter: "cleanup-complete",
      generated: "explainer",
    });
  });

  it("should enlarge safe operation targets instead of drawing black masks", () => {
    const ranges = RECORDED_LITE_EDITS.flatMap((edit) => edit.sourceRanges);
    const graph = buildRecordedFilterGraph(ranges);
    expect(graph).not.toContain("drawbox");
    expect(graph).toContain("crop=540:304:100:30");
    expect(graph).toContain("pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xf5f7fa");
    for (const range of ranges) {
      if (!range.focus) continue;
      expect(range.focus.x + range.focus.width, range.chapter).toBeLessThanOrEqual(1280);
      expect(range.focus.y + range.focus.height, range.chapter).toBeLessThanOrEqual(720);
    }
  });

  it("should crop or omit credentials, account ids, and answer values", () => {
    const deploy = RECORDED_LITE_EDITS.find((edit) => edit.problemId === "deploy-tenkacloud-lite");
    expect(deploy).toBeDefined();
    const omittedUnsafeTimes = [
      0, 5, 40, 67, 118, 136, 148, 200, 235, 244, 304, 335, 350, 352, 367, 494.7,
    ];
    for (const unsafeTime of omittedUnsafeTimes) {
      expect(
        deploy?.sourceRanges.some(
          (range) =>
            range.generated === undefined && range.startS <= unsafeTime && unsafeTime < range.endS,
        ),
        `source ${unsafeTime}s`,
      ).toBe(false);
    }

    for (const protectedTime of [
      46, 52, 60, 108, 130, 170, 190, 194, 196, 219, 225, 230, 312, 316, 320, 330, 357, 366,
    ]) {
      const range = deploy?.sourceRanges.find(
        (candidate) => candidate.startS <= protectedTime && protectedTime < candidate.endS,
      );
      if (range) expect(range.focus, `source ${protectedTime}s`).toBeDefined();
    }

    const cleanup = RECORDED_LITE_EDITS.find(
      (edit) => edit.problemId === "cleanup-tenkacloud-lite",
    );
    for (const unsafeTime of [
      510, 514.5, 519, 520, 526, 529.8, 598, 620, 622.5, 623.5, 660, 770.8,
    ]) {
      expect(
        cleanup?.sourceRanges.some(
          (range) =>
            range.generated === undefined && range.startS <= unsafeTime && unsafeTime < range.endS,
        ),
        `source ${unsafeTime}s`,
      ).toBe(false);
    }
    for (const protectedTime of [528, 529, 590, 631, 642]) {
      const range = cleanup?.sourceRanges.find(
        (candidate) => candidate.startS <= protectedTime && protectedTime < candidate.endS,
      );
      expect(range?.focus, `source ${protectedTime}s`).toBeDefined();
    }
    const lastCleanupRecording = cleanup?.sourceRanges.findLast((range) => !range.generated);
    expect(lastCleanupRecording?.endS).toBeLessThan(660);
  });

  it("should reject an empty edit rather than emitting a blank video", () => {
    expect(() => buildRecordedFilterGraph([])).toThrow("At least one source range is required");
  });

  it("should allow rendering only the requested external upload master", () => {
    expect(
      selectRecordedLiteEdits("cleanup-tenkacloud-lite").map((edit) => edit.problemId),
    ).toEqual(["cleanup-tenkacloud-lite"]);
    expect(selectRecordedLiteEdits()).toEqual(RECORDED_LITE_EDITS);
    expect(() => selectRecordedLiteEdits("unknown")).toThrow("Unknown recorded Lite problem");
  });
});
