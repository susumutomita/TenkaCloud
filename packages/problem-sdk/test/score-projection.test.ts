import { describe, expect, it } from "vitest";
import { projectScore, projectScoreTimeline } from "../src/score-projection.js";

describe("pinned per-problem score projection", () => {
  it("keeps wrong-answer debt under a pinned floor and leaves Battle penalties signed", () => {
    const policies = [
      { problemId: "hello-world", scoreFloor: 0 },
      { problemId: "hello-world-battle" },
    ];
    const entries = [
      { problemId: "hello-world", points: -5 },
      { problemId: "hello-world", points: 100 },
      { problemId: "hello-world-battle", points: -100 },
    ];
    expect(projectScoreTimeline(policies, entries)).toEqual([0, 95, -5]);
    expect(projectScore(policies, entries)).toEqual({
      total: -5,
      byProblem: { "hello-world": 95, "hello-world-battle": -100 },
    });
    expect(projectScore([{ problemId: "hello-world" }], entries.slice(0, 1)).total).toBe(-5);
  });

  it("projects hint debt and a later gate bonus through the same problem floor", () => {
    const policies = [{ problemId: "hello-world", scoreFloor: 0 }];
    const entries = [
      { problemId: "hello-world", points: -20 },
      { problemId: "hello-world", points: -30 },
      { problemId: "hello-world", points: 100 },
    ];
    expect(projectScoreTimeline(policies, entries)).toEqual([0, 0, 50]);
    expect(projectScore(policies, entries).total).toBe(50);
  });

  it("rejects a ledger that does not belong to the event's pinned problems", () => {
    const policies = [{ problemId: "hello-world", scoreFloor: 0 }];
    expect(() => projectScore(policies, [{ problemId: "other", points: 10 }])).toThrow(
      "unpinned problem",
    );
    expect(() => projectScoreTimeline(policies, [{ problemId: "other", points: 10 }])).toThrow(
      "unpinned problem",
    );
  });

  it("rejects ambiguous policies and non-finite ledger values", () => {
    expect(() =>
      projectScore([{ problemId: "hello-world" }, { problemId: "hello-world", scoreFloor: 0 }], []),
    ).toThrow("unique pinned problem IDs");
    expect(() => projectScore([{ problemId: "hello-world", scoreFloor: Number.NaN }], [])).toThrow(
      "Invalid score floor",
    );
    expect(() =>
      projectScore(
        [{ problemId: "hello-world" }],
        [{ problemId: "hello-world", points: Number.POSITIVE_INFINITY }],
      ),
    ).toThrow("finite");
  });
});
