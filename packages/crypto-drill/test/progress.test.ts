import { describe, expect, it } from "vitest";
import { loc } from "../src/drill/authoring";
import {
  completedSectionCount,
  emptyProgress,
  firstIncompleteSection,
  isSectionComplete,
  parseProgress,
  recordAttempt,
  renderProgressBar,
  revealNextHint,
  serializeProgress,
  taskProgress,
} from "../src/drill/progress";
import type { Drill, DrillSection } from "../src/drill/types";

function section(id: string, order: number, taskIds: readonly string[]): DrillSection {
  return {
    id,
    order,
    title: loc("題", "Title"),
    goal: loc("目標", "Goal"),
    reading: [loc("本文", "Body")],
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      kind: "value" as const,
      title: loc("題", "Title"),
      instruction: loc("説明", "Instruction"),
      hints: [],
      cases: [],
    })),
    explanation: [loc("解説", "Explanation")],
    nextStep: loc("次", "Next"),
  };
}

const drill: Drill = {
  id: "sha256",
  title: loc("題", "Title"),
  summary: loc("概要", "Summary"),
  sections: [section("one", 1, ["t1", "t2"]), section("two", 2, ["t3"])],
};

describe("drill progress", () => {
  it("should start with nothing recorded", () => {
    const progress = emptyProgress("sha256");
    expect(progress).toEqual({ version: 1, drillId: "sha256", tasks: {} });
    expect(taskProgress(progress, "t1")).toEqual({
      completed: false,
      attempts: 0,
      revealedHints: 0,
    });
  });

  it("should count attempts whether or not they pass", () => {
    let progress = emptyProgress("sha256");
    progress = recordAttempt(progress, "t1", false);
    progress = recordAttempt(progress, "t1", true);
    expect(taskProgress(progress, "t1")).toEqual({
      completed: true,
      attempts: 2,
      revealedHints: 0,
    });
  });

  it("should keep a completed task completed after a later wrong attempt", () => {
    let progress = recordAttempt(emptyProgress("sha256"), "t1", true);
    progress = recordAttempt(progress, "t1", false);
    expect(taskProgress(progress, "t1").completed).toBe(true);
    expect(taskProgress(progress, "t1").attempts).toBe(2);
  });

  it("should reveal hints one at a time and stop at the hint count", () => {
    let progress = emptyProgress("sha256");
    progress = revealNextHint(progress, "t1", 2);
    expect(taskProgress(progress, "t1").revealedHints).toBe(1);
    progress = revealNextHint(progress, "t1", 2);
    expect(taskProgress(progress, "t1").revealedHints).toBe(2);
    const capped = revealNextHint(progress, "t1", 2);
    expect(capped).toBe(progress);
  });

  it("should not reveal anything for a task without hints", () => {
    const progress = revealNextHint(emptyProgress("sha256"), "t1", 0);
    expect(taskProgress(progress, "t1").revealedHints).toBe(0);
  });

  it("should treat a section as complete only when all of its tasks are", () => {
    const first = drill.sections[0] as DrillSection;
    let progress = recordAttempt(emptyProgress("sha256"), "t1", true);
    expect(isSectionComplete(first, progress)).toBe(false);
    progress = recordAttempt(progress, "t2", true);
    expect(isSectionComplete(first, progress)).toBe(true);
    expect(completedSectionCount(drill, progress)).toBe(1);
  });

  it("should point at the first section that is not complete", () => {
    expect(firstIncompleteSection(drill, emptyProgress("sha256"))?.id).toBe("one");
    let progress = recordAttempt(emptyProgress("sha256"), "t1", true);
    progress = recordAttempt(progress, "t2", true);
    expect(firstIncompleteSection(drill, progress)?.id).toBe("two");
    progress = recordAttempt(progress, "t3", true);
    expect(firstIncompleteSection(drill, progress)).toBeUndefined();
  });

  it("should render the progress bar with one cell per section", () => {
    expect(renderProgressBar(6, 15)).toBe("██████□□□□□□□□□");
    expect(renderProgressBar(0, 3)).toBe("□□□");
    expect(renderProgressBar(3, 3)).toBe("███");
  });

  it("should clamp an out-of-range done count instead of overflowing the bar", () => {
    expect(renderProgressBar(-1, 3)).toBe("□□□");
    expect(renderProgressBar(9, 3)).toBe("███");
    expect(renderProgressBar(1, 0)).toBe("");
  });

  it("should round-trip through serialization", () => {
    const progress = recordAttempt(emptyProgress("sha256"), "t1", true);
    const restored = parseProgress(serializeProgress(progress), "sha256");
    expect(restored).toEqual(progress);
  });

  it("should reject stored values that are not usable progress", () => {
    expect(parseProgress("not json", "sha256")).toBeNull();
    expect(
      parseProgress(JSON.stringify({ version: 2, drillId: "sha256", tasks: {} }), "sha256"),
    ).toBeNull();
    expect(
      parseProgress(JSON.stringify({ version: 1, drillId: "", tasks: {} }), "sha256"),
    ).toBeNull();
    expect(
      parseProgress(
        JSON.stringify({ version: 1, drillId: "sha256", tasks: { t1: { completed: "yes" } } }),
        "sha256",
      ),
    ).toBeNull();
    expect(
      parseProgress(
        JSON.stringify({
          version: 1,
          drillId: "sha256",
          tasks: { t1: { completed: true, attempts: -1, revealedHints: 0 } },
        }),
        "sha256",
      ),
    ).toBeNull();
  });

  it("should refuse progress saved under a different drill id", () => {
    const other = serializeProgress(emptyProgress("sha1"));
    expect(parseProgress(other, "sha256")).toBeNull();
  });
});
