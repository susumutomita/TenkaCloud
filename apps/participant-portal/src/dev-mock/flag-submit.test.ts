import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_FIRST_SCORE,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_MOCK_FLAG,
  evaluateMockFlag,
  evaluateMockSubFlag,
  UNDERSTAND_DRILL_PROBLEM_ID,
} from "./flag-submit";

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

describe("evaluateMockSubFlag (#2707 understand quiz)", () => {
  it("should accept quiz answers case-insensitively including Japanese variants", () => {
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "category-realtime", " Battle ", 50).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "category-selfpaced", "チャレンジ", 50).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "competitor-screen", "portal", 50).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "single-account-mode", "Lite", 50).kind,
    ).toBe("ok");
  });

  it("should reject wrong quiz answers, Easter eggs, and unknown quiz flag ids", () => {
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "category-realtime", "challenge", 50).kind,
    ).toBe("wrong");
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "category-realtime", "42", 50).kind,
    ).toBe("wrong");
    expect(
      evaluateMockSubFlag(UNDERSTAND_DRILL_PROBLEM_ID, "no-such-question", "battle", 50).kind,
    ).toBe("wrong");
  });
});

describe("evaluateMockSubFlag (#2707 local-mode drill)", () => {
  it("should accept the port quiz answer and the first-score checkpoint code", () => {
    expect(evaluateMockSubFlag(LOCAL_DRILL_PROBLEM_ID, "portal-port", " 5175 ", 100).kind).toBe(
      "ok",
    );
    expect(
      evaluateMockSubFlag(
        LOCAL_DRILL_PROBLEM_ID,
        LOCAL_DRILL_FIRST_SCORE.flagId,
        ` ${LOCAL_DRILL_FIRST_SCORE.code.toLowerCase()} `,
        100,
      ).kind,
    ).toBe("ok");
  });

  it("should reject wrong answers and cross-drill codes on the local drill", () => {
    expect(evaluateMockSubFlag(LOCAL_DRILL_PROBLEM_ID, "portal-port", "5173", 100).kind).toBe(
      "wrong",
    );
    expect(
      evaluateMockSubFlag(
        LOCAL_DRILL_PROBLEM_ID,
        LOCAL_DRILL_FIRST_SCORE.flagId,
        LITE_DRILL_CHECKPOINTS.deployComplete.code,
        100,
      ).kind,
    ).toBe("wrong");
  });
});
