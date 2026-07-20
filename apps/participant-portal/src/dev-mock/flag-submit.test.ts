import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_FIRST_SCORE,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  CANONICAL_MOCK_FLAG,
  evaluateMockFlag,
  evaluateMockProblemFlag,
  evaluateMockSubFlag,
  WHAT_IS_DRILL_PROBLEM_ID,
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

describe("evaluateMockProblemFlag (first browser drill)", () => {
  it("scores the answer printed by number-sequence and rejects generic demo flags", () => {
    expect(evaluateMockProblemFlag("number-sequence", " TC{21} ", 300)).toMatchObject({
      kind: "ok",
      scoreDelta: 300,
    });
    expect(evaluateMockProblemFlag("number-sequence", CANONICAL_MOCK_FLAG, 300).kind).toBe("wrong");
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

describe("evaluateMockSubFlag (#2711 what-is-tenkacloud tutorial)", () => {
  it("should accept the reading-quiz answers case-insensitively including Japanese variants", () => {
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", " 本物のクラウド ", 100).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "Real Cloud", 100).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "battle-challenge", " Battle ", 100).kind,
    ).toBe("ok");
  });

  it("should accept either mode at the step-3 choice (choice, not quiz)", () => {
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "Lite", 100).kind).toBe(
      "ok",
    );
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "ブラウザ", 100).kind).toBe(
      "ok",
    );
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "Codespaces", 100).kind,
    ).toBe("ok");
  });

  it("should score the printed practice flag at step 4 with paste tolerance", () => {
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", " TENKA{HELLO-TENKACLOUD} ", 100)
        .kind,
    ).toBe("ok");
  });

  it("should reject wrong answers, Easter eggs, and unknown step ids", () => {
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "battle-challenge", "challenge", 100).kind,
    ).toBe("wrong");
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "42", 100).kind).toBe(
      "wrong",
    );
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "no-such-step", "battle", 100).kind).toBe(
      "wrong",
    );
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

describe("evaluateMockSubFlag (AI-agent local Mac tutorial)", () => {
  it("should accept the canonical briefing filename and the confirmed portal port", () => {
    expect(
      evaluateMockSubFlag(AI_AGENT_LOCAL_DRILL_PROBLEM_ID, "briefing-file", " llms-full.txt ", 100)
        .kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(AI_AGENT_LOCAL_DRILL_PROBLEM_ID, "portal-port", " 5175 ", 100).kind,
    ).toBe("ok");
  });

  it("should reject generic flags, the Codespaces port, and unknown checkpoints", () => {
    expect(
      evaluateMockSubFlag(
        AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
        "briefing-file",
        CANONICAL_MOCK_FLAG,
        100,
      ).kind,
    ).toBe("wrong");
    expect(
      evaluateMockSubFlag(AI_AGENT_LOCAL_DRILL_PROBLEM_ID, "portal-port", "5173", 100).kind,
    ).toBe("wrong");
    expect(evaluateMockSubFlag(AI_AGENT_LOCAL_DRILL_PROBLEM_ID, "unknown", "5175", 100).kind).toBe(
      "wrong",
    );
  });
});
