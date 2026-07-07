import { describe, expect, it } from "vitest";
import { parseProblemIds } from "../../../scripts/local-play/deployment-plan";

describe("deployment-plan: parseProblemIds (#2392)", () => {
  it("should split, trim, drop blanks, and de-dup preserving order", () => {
    expect(parseProblemIds("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(parseProblemIds("a,,a, b,a")).toEqual(["a", "b"]);
    expect(parseProblemIds("solo")).toEqual(["solo"]);
    expect(parseProblemIds("  ,  ")).toEqual([]);
  });
});
