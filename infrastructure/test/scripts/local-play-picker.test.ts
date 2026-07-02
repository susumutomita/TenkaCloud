import { describe, expect, it } from "vitest";
import type { LocalPlayProblemSummary } from "../../../scripts/local-play/manifest";
import { renderProblemMenu, resolveProblemSelection } from "../../../scripts/local-play/picker";

const summaries: LocalPlayProblemSummary[] = [
  { problemId: "sqli-demo", name: "スタッフ専用ログイン", category: "challenges" },
  { problemId: "wp-exposed-backup", name: "前任者の忘れ物", category: "challenges" },
];

describe("renderProblemMenu (#2188)", () => {
  it("should number every problem and align the ids", () => {
    expect(renderProblemMenu(summaries)).toBe(
      [
        "Choose a problem to play locally:",
        "",
        "  1) sqli-demo          スタッフ専用ログイン",
        "  2) wp-exposed-backup  前任者の忘れ物",
      ].join("\n"),
    );
  });

  it("should widen the number column past nine problems", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      problemId: `p${i}`,
      name: `name-${i}`,
      category: "challenges",
    }));
    const lines = renderProblemMenu(many).split("\n");
    // Single-digit rows get a leading space so "10)" lines up under "1)".
    expect(lines[2]).toBe("   1) p0  name-0");
    expect(lines[11]).toBe("  10) p9  name-9");
  });
});

describe("resolveProblemSelection (#2188)", () => {
  it("should resolve a 1-based menu number to that problem", () => {
    expect(resolveProblemSelection("2", summaries)).toBe("wp-exposed-backup");
  });

  it("should resolve an exact problem id", () => {
    expect(resolveProblemSelection("sqli-demo", summaries)).toBe("sqli-demo");
  });

  it("should tolerate surrounding whitespace", () => {
    expect(resolveProblemSelection("  1 \n", summaries)).toBe("sqli-demo");
  });

  it("should reject empty input rather than defaulting", () => {
    expect(resolveProblemSelection("   ", summaries)).toBeUndefined();
  });

  it("should reject an out-of-range number", () => {
    expect(resolveProblemSelection("0", summaries)).toBeUndefined();
    expect(resolveProblemSelection("3", summaries)).toBeUndefined();
  });

  it("should reject an unknown id", () => {
    expect(resolveProblemSelection("does-not-exist", summaries)).toBeUndefined();
  });
});
