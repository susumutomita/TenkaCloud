import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  evaluateMockSubFlag,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "../dev-mock/flag-submit";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";

/**
 * Issue #2696 / #2707 / #2711: LP デモの固定出題 (オンボーディングドリル + 2 クエスト) の
 * 整合性を pin する。 ドリルの sub-flag id が判定側 (`evaluateMockSubFlag`) と揃って
 * いなければ永遠に wrong を返すし、 ヒントの無いドリルは「本文は概要 → ヒントで
 * ステップバイステップ」 という構造契約を破る。 #2711 で問題 1 は what-is-tenkacloud
 * (4 ステップ、 モード 2 択はステップ 3) になり、 AI/Mac 実演は Codespaces 問題と
 * 混ぜずに独立した 4 問目として置く。
 */
describe("dev-mock fixtures", () => {
  const ONBOARDING_DRILL_IDS = [
    WHAT_IS_DRILL_PROBLEM_ID,
    LITE_DRILL_PROBLEM_ID,
    LOCAL_DRILL_PROBLEM_ID,
    AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  ];
  const drills = DEV_MOCK_TEAM_VIEW.problems.filter((p) =>
    ONBOARDING_DRILL_IDS.includes(p.problemId),
  );

  it("should pin the onboarding drills first, in journey order (#2711)", () => {
    expect(DEV_MOCK_TEAM_VIEW.problems.slice(0, 4).map((p) => p.problemId)).toEqual(
      ONBOARDING_DRILL_IDS,
    );
  });

  it("should give the tutorial the 4-step shape with the mode choice at step 3 (#2711)", () => {
    const tutorial = drills.find((p) => p.problemId === WHAT_IS_DRILL_PROBLEM_ID);
    expect(tutorial?.scoring?.flags?.map((f) => f.id)).toEqual([
      "tenka-what",
      "battle-challenge",
      "choose-mode",
      "first-flag",
    ]);
    // モードの 2 択はステップ 3 のセクションで初めて出す (それ以前の本文に出さない)。
    const body = tutorial?.description ?? "";
    const step3At = body.indexOf("ステップ 3");
    expect(step3At).toBeGreaterThan(-1);
    expect(body.slice(0, step3At)).not.toContain("Codespaces");
    // どちらのモードを選んでも正解 (= クイズではなく選択)。
    expect(evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "lite", 100).kind).toBe(
      "ok",
    );
    expect(
      evaluateMockSubFlag(WHAT_IS_DRILL_PROBLEM_ID, "choose-mode", "codespaces", 100).kind,
    ).toBe("ok");
  });

  it("should ship every onboarding problem as an unsolved multi-flag drill", () => {
    expect(drills).toHaveLength(4);
    for (const drill of drills) {
      expect(drill.scoring?.kind).toBe("multi-flag");
      expect(drill.score).toBe(0);
      expect(drill.scoring?.flags?.length).toBeGreaterThan(0);
      expect(drill.scoring?.flags?.every((f) => !f.solved)).toBe(true);
    }
  });

  it("should give every drill sub-flag a penalty-free step-by-step hint with content", () => {
    for (const drill of drills) {
      for (const flag of drill.scoring?.flags ?? []) {
        expect(flag.hints, `${drill.problemId}/${flag.id} has no hints`).toBeDefined();
        for (const hint of flag.hints ?? []) {
          expect(hint.penalty).toBe(0);
          expect(hint.revealed).toBe(false);
          // dev-mock は reveal をローカル state で行うため content を同梱する。
          expect(hint.content).toBeTruthy();
          // #2711 follow-up: en locale でヒントが日本語のまま出る bug の再発防止 — 全ヒントに英訳を同梱。
          expect(
            hint.i18n?.en?.content,
            `${drill.problemId}/${flag.id}/${hint.id} has no en hint`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("should keep the lite drill sub-flag ids aligned with the lite-drill contract, in journey order", () => {
    const lite = drills.find((p) => p.problemId === LITE_DRILL_PROBLEM_ID);
    expect(lite?.scoring?.flags?.map((f) => f.id)).toEqual([
      LITE_DRILL_CHECKPOINTS.launcherCreated.flagId,
      LITE_DRILL_CHECKPOINTS.deployComplete.flagId,
      LITE_DRILL_CHECKPOINTS.competitorVerified.flagId,
      LITE_DRILL_CHECKPOINTS.firstEventCreated.flagId,
    ]);
  });

  it("should make every drill sub-flag strict: the generic mock flag never solves it", () => {
    for (const drill of drills) {
      for (const flag of drill.scoring?.flags ?? []) {
        const outcome = evaluateMockSubFlag(drill.problemId, flag.id, "tenkacloudsample", 10);
        expect(outcome.kind, `${drill.problemId}/${flag.id} accepted the generic flag`).toBe(
          "wrong",
        );
      }
    }
  });

  it("should ship the drill narratives in both Japanese and English", () => {
    for (const drill of drills) {
      expect(drill.name).toBeTruthy();
      expect(drill.description).toBeTruthy();
      expect(drill.instructions).toBeTruthy();
      expect(drill.i18n?.en?.name).toBeTruthy();
      expect(drill.i18n?.en?.description).toBeTruthy();
      expect(drill.i18n?.en?.instructions).toBeTruthy();
      for (const flag of drill.scoring?.flags ?? []) {
        expect(flag.i18n?.en?.label).toBeTruthy();
      }
    }
  });

  it("should localize the AI-agent Mac tutorial video for English", () => {
    const drill = DEV_MOCK_TEAM_VIEW.problems.find(
      (problem) => problem.problemId === "ai-agent-local-mac",
    );
    expect(drill?.videoUrl).toBe("https://www.youtube.com/embed/nLsSJ3npdfw");
    expect(drill?.i18n?.en?.videoUrl).toBe("https://www.youtube.com/embed/GDu9FhWrQns");
  });

  it("should ship a playable onboarding video on every onboarding drill (#2707 P0-1)", () => {
    for (const drill of drills) {
      // AI-agent tutorial はリポジトリ肥大化を避けるため YouTube へ分離する。
      if (drill.problemId === "ai-agent-local-mac") {
        expect(drill.videoUrl).toBe("https://www.youtube.com/embed/nLsSJ3npdfw");
        continue;
      }
      // その他は problemId とファイル名を一致させる既存 contract を維持する。
      expect(drill.videoUrl).toBe(`/videos/onboarding/${drill.problemId}.mp4`);
    }
  });

  it("should keep the leaderboard problem totals in sync with the fixture problem count", () => {
    const total = DEV_MOCK_TEAM_VIEW.problems.length;
    for (const entry of DEV_MOCK_LEADERBOARD.entries) {
      expect(entry.totalProblems).toBe(total);
    }
  });

  it("should announce the onboarding drills in the notifications feed", () => {
    const bodies = DEV_MOCK_NOTIFICATIONS.items.map((n) => `${n.title} ${n.body}`).join("\n");
    expect(bodies).toContain("TenkaCloud とは?");
    expect(bodies).toContain("ローカルモードで遊ぶ");
    expect(bodies).toContain("自分の TenkaCloud Lite を立てる");
    expect(bodies).toContain("AIエージェントでMac起動");
  });
});
