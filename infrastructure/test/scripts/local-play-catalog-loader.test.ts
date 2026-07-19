import { describe, expect, it } from "vitest";
import {
  LOCAL_INTRO_DRILL_PROBLEM_ID,
  pinIntroDrillFirst,
} from "../../../scripts/local-play/catalog-loader";

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
