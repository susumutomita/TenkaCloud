import {
  LITE_CLEANUP_DRILL_CHECKPOINT,
  LITE_CLEANUP_DRILL_PROBLEM_ID,
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_LAUNCH_COMMAND,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  CANONICAL_MOCK_FLAG,
  CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
  CUSTOM_CHALLENGE_PROBLEM_ID,
  CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
  evaluateMockFlag,
  evaluateMockSubFlag,
  isStrictDrillProblem,
  resetMockScoring,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "./flag-submit";

// evaluateMockSubFlag は問題スコア / 不正解回数を module 内に蓄積するため、
// テスト間で毎回リセットして順序依存を断つ。
beforeEach(() => {
  resetMockScoring();
});

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

describe("evaluateMockSubFlag scoring accumulation", () => {
  it("should count repeated wrong submissions so the alert visibly changes every attempt", () => {
    // 同じ誤答を繰り返しても表示が変わらず「反応が無い」ように見えた 2026-07-21 の
    // デモ報告の再発防止: wrongCount が 1 → 2 と進む。
    const first = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", "nope", 100);
    const second = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", "nope", 100);
    expect(first).toMatchObject({ kind: "wrong", scoreDelta: -10, wrongCount: 1 });
    expect(second).toMatchObject({ kind: "wrong", scoreDelta: -10, wrongCount: 2 });
  });

  it("should floor the problem total at 0 pt and add solved points on top", () => {
    const wrong = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", "nope", 100);
    expect(wrong).toMatchObject({ kind: "wrong", totalScore: 0 });
    const ok = evaluateMockSubFlag(
      WHAT_IS_DRILL_PROBLEM_ID,
      "first-flag",
      "TC{HELLO-TENKACLOUD}",
      100,
    );
    expect(ok).toMatchObject({ kind: "ok", scoreDelta: 100, totalScore: 100 });
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

describe("evaluateMockSubFlag (Lite cleanup drill)", () => {
  const { flagId, code } = LITE_CLEANUP_DRILL_CHECKPOINT;

  it("should accept only the cleanup checkpoint for the cleanup problem", () => {
    expect(evaluateMockSubFlag(LITE_CLEANUP_DRILL_PROBLEM_ID, flagId, code, 100)).toMatchObject({
      kind: "ok",
      scoreDelta: 100,
    });
    expect(
      evaluateMockSubFlag(
        LITE_CLEANUP_DRILL_PROBLEM_ID,
        flagId,
        LITE_DRILL_CHECKPOINTS.deployComplete.code,
        100,
      ).kind,
    ).toBe("wrong");
  });
});

describe("evaluateMockSubFlag (#2814 what-is-tenkacloud tutorial)", () => {
  it("should score only the practice flag submission with paste tolerance", () => {
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", " TC{HELLO-TENKACLOUD} ", 100)
        .kind,
    ).toBe("ok");
  });

  it("should reject obsolete quiz steps, Easter eggs, and unknown step ids", () => {
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "real cloud", 100).kind,
    ).toBe("wrong");
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "first-flag", "42", 100).kind).toBe(
      "wrong",
    );
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "no-such-step", "battle", 100).kind).toBe(
      "wrong",
    );
  });
});

describe("evaluateMockSubFlag (#2707 local-mode drill)", () => {
  it("should accept the port quiz answer and the launch-command checkpoint code", () => {
    expect(evaluateMockSubFlag(LOCAL_DRILL_PROBLEM_ID, "portal-port", " 5175 ", 100).kind).toBe(
      "ok",
    );
    expect(
      evaluateMockSubFlag(
        LOCAL_DRILL_PROBLEM_ID,
        LOCAL_DRILL_LAUNCH_COMMAND.flagId,
        ` ${LOCAL_DRILL_LAUNCH_COMMAND.code.toUpperCase()} `,
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
        LOCAL_DRILL_LAUNCH_COMMAND.flagId,
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

describe("evaluateMockSubFlag (#2781 add-custom-challenge drill)", () => {
  it("should accept the validated problem count for the first checkpoint", () => {
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
        " 2 ",
        100,
      ).kind,
    ).toBe("ok");
  });

  it("should reject a count that means the author replaced hello-world instead of adding to it", () => {
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
        "1",
        100,
      ).kind,
    ).toBe("wrong");
  });

  it("should accept the verifier checkpoint for an author-chosen problem id, case-insensitively", () => {
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
        " TC{CUSTOM-CHALLENGE:my-first-problem} ",
        100,
      ).kind,
    ).toBe("ok");
    expect(
      evaluateMockSubFlag(
        CUSTOM_CHALLENGE_PROBLEM_ID,
        CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
        "tc{custom-challenge:s3lab}",
        100,
      ).kind,
    ).toBe("ok");
  });

  it("should reject the scaffold and golden ids so copying without authoring never scores", () => {
    for (const reserved of ["hello-world", "HELLO-WORLD", "golden-basic-find-the-flag"]) {
      expect(
        evaluateMockSubFlag(
          CUSTOM_CHALLENGE_PROBLEM_ID,
          CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
          `TC{CUSTOM-CHALLENGE:${reserved}}`,
          100,
        ).kind,
      ).toBe("wrong");
    }
  });

  it("should reject malformed checkpoints, generic flags, and Easter eggs", () => {
    for (const bad of [
      CANONICAL_MOCK_FLAG,
      "42",
      "TC{CUSTOM-CHALLENGE:}",
      "TC{CUSTOM-CHALLENGE:Bad_Id}",
      "TC{CUSTOM-CHALLENGE:trailing-}",
      "custom-challenge:my-problem",
      "TC{CUSTOM-CHALLENGE:my-problem} extra",
    ]) {
      expect(
        evaluateMockSubFlag(
          CUSTOM_CHALLENGE_PROBLEM_ID,
          CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
          bad,
          100,
        ).kind,
      ).toBe("wrong");
    }
  });
});

describe("isStrictDrillProblem (#2781 derivation)", () => {
  it("should treat every quiz-answer drill as strict, including the AI-agent tutorial", () => {
    // #2781: ai-agent-local-mac は厳密採点なのに列挙漏れで緩い案内が出ていた回帰の pin。
    for (const problemId of [
      WHAT_IS_DRILL_PROBLEM_ID,
      AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
      LOCAL_DRILL_PROBLEM_ID,
      CUSTOM_CHALLENGE_PROBLEM_ID,
    ]) {
      expect(isStrictDrillProblem(problemId)).toBe(true);
    }
  });

  it("should keep the checkpoint-only drills strict even though they have no quiz answers", () => {
    expect(isStrictDrillProblem(LITE_DRILL_PROBLEM_ID)).toBe(true);
    expect(isStrictDrillProblem(LITE_CLEANUP_DRILL_PROBLEM_ID)).toBe(true);
  });

  it("should not treat ordinary demo problems or Object prototype keys as strict drills", () => {
    expect(isStrictDrillProblem("some-demo-problem")).toBe(false);
    // Object.hasOwn を使わないと `in` が prototype key を拾って true になる。
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(isStrictDrillProblem(key)).toBe(false);
    }
  });
});
