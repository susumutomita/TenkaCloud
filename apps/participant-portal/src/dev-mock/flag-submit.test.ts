import { LITE_DRILL_CHECKPOINTS, LITE_DRILL_PROBLEM_ID } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import { CANONICAL_MOCK_FLAG, evaluateMockFlag, evaluateMockSubFlag } from "./flag-submit";

describe("evaluateMockFlag", () => {
  it("should accept the canonical flag and inputs containing it", () => {
    expect(evaluateMockFlag(CANONICAL_MOCK_FLAG, 300).kind).toBe("ok");
    expect(evaluateMockFlag(`  TC{${CANONICAL_MOCK_FLAG}} `, 300).kind).toBe("ok");
  });

  it("should accept a prefix of the canonical flag and Easter eggs", () => {
    expect(evaluateMockFlag("tenkacloud", 300).kind).toBe("ok");
    expect(evaluateMockFlag("42", 300).kind).toBe("ok");
  });

  it("should reject an empty input and a wrong flag with a -10 pt penalty", () => {
    expect(evaluateMockFlag("   ", 300).kind).toBe("wrong");
    const wrong = evaluateMockFlag("not-a-flag", 300);
    expect(wrong).toMatchObject({ kind: "wrong", scoreDelta: -10 });
  });
});

describe("evaluateMockSubFlag (#2696 Lite deploy drill)", () => {
  const { flagId, code } = LITE_DRILL_CHECKPOINTS.deployComplete;

  it("should score a drill sub-flag when the matching checkpoint code is submitted", () => {
    const outcome = evaluateMockSubFlag(LITE_DRILL_PROBLEM_ID, flagId, code, 100);
    expect(outcome).toMatchObject({ kind: "ok", scoreDelta: 100, totalScore: 100 });
  });

  it("should tolerate copy-paste whitespace and letter-case differences", () => {
    const sloppy = `  ${code.toLowerCase()} `;
    expect(evaluateMockSubFlag(LITE_DRILL_PROBLEM_ID, flagId, sloppy, 100).kind).toBe("ok");
  });

  it("should reject the generic mock flag and Easter eggs on the drill", () => {
    expect(evaluateMockSubFlag(LITE_DRILL_PROBLEM_ID, flagId, CANONICAL_MOCK_FLAG, 100).kind).toBe(
      "wrong",
    );
    expect(evaluateMockSubFlag(LITE_DRILL_PROBLEM_ID, flagId, "42", 100).kind).toBe("wrong");
  });

  it("should reject another checkpoint's code on the wrong step", () => {
    const other = LITE_DRILL_CHECKPOINTS.launcherCreated.code;
    expect(evaluateMockSubFlag(LITE_DRILL_PROBLEM_ID, flagId, other, 100).kind).toBe("wrong");
  });

  it("should fall back to the generic mock evaluation for non-drill problems", () => {
    expect(evaluateMockSubFlag("net-evo", "ep01", CANONICAL_MOCK_FLAG, 300).kind).toBe("ok");
    expect(evaluateMockSubFlag("net-evo", "ep01", "not-a-flag", 300).kind).toBe("wrong");
  });
});
