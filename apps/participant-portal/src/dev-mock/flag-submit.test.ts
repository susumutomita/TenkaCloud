import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_LAUNCH_COMMAND,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  CANONICAL_MOCK_FLAG,
  evaluateMockFlag,
  evaluateMockSubFlag,
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
    const first = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "nope", 100);
    const second = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "nope", 100);
    expect(first).toMatchObject({ kind: "wrong", scoreDelta: -10, wrongCount: 1 });
    expect(second).toMatchObject({ kind: "wrong", scoreDelta: -10, wrongCount: 2 });
  });

  it("should floor the problem total at 0 pt and add solved points on top", () => {
    const wrong = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "nope", 100);
    expect(wrong).toMatchObject({ kind: "wrong", totalScore: 0 });
    const ok = evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "tenka-what", "real cloud", 100);
    expect(ok).toMatchObject({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    const okAgain = evaluateMockSubFlag(
      WHAT_IS_DRILL_PROBLEM_ID,
      "battle-challenge",
      "battle",
      100,
    );
    expect(okAgain).toMatchObject({ kind: "ok", totalScore: 200 });
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

  it("should accept any real mode at the step-3 choice (choice, not quiz)", () => {
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "Local", 100).kind).toBe(
      "ok",
    );
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "ローカルモード", 100).kind,
    ).toBe("ok");
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "Lite", 100).kind).toBe(
      "ok",
    );
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "SaaS", 100).kind).toBe(
      "ok",
    );
    // Codespaces はローカルモードの実行環境の 1 つなので正解のまま。
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "Codespaces", 100).kind,
    ).toBe("ok");
    // 「ブラウザ (Lite)」 は実在しないモード名 (このタブはデモ) — 正解にしない。
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "ブラウザ (Lite)", 100).kind,
    ).toBe("wrong");
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
