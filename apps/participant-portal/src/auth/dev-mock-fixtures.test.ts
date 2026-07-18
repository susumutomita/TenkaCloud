import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import { evaluateMockSubFlag, UNDERSTAND_DRILL_PROBLEM_ID } from "../dev-mock/flag-submit";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";

/**
 * Issue #2696 / #2707: LP デモの固定出題 (オンボーディング 3 部作 + 2 クエスト) の
 * 整合性を pin する。 ドリルの sub-flag id が判定側 (`evaluateMockSubFlag`) と揃って
 * いなければ永遠に wrong を返すし、 ヒントの無いドリルは「本文は概要 → ヒントで
 * ステップバイステップ」 という 3 部作の構造契約を破る。
 */
describe("dev-mock fixtures", () => {
  const TRILOGY_IDS = [UNDERSTAND_DRILL_PROBLEM_ID, LOCAL_DRILL_PROBLEM_ID, LITE_DRILL_PROBLEM_ID];
  const drills = DEV_MOCK_TEAM_VIEW.problems.filter((p) => TRILOGY_IDS.includes(p.problemId));

  it("should pin the onboarding trilogy first, in journey order", () => {
    expect(DEV_MOCK_TEAM_VIEW.problems.slice(0, 3).map((p) => p.problemId)).toEqual(TRILOGY_IDS);
  });

  it("should ship every trilogy problem as an unsolved multi-flag drill", () => {
    expect(drills).toHaveLength(3);
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

  it("should ship a self-hosted onboarding video on every trilogy drill (#2707 P0-1)", () => {
    for (const drill of drills) {
      // 同一 origin の自ホスト mp4 のみ (landing CSP)。 URL は problemId と揃えて迷子を防ぐ。
      expect(drill.videoUrl).toBe(`/videos/onboarding/${drill.problemId}.mp4`);
    }
  });

  it("should keep the leaderboard problem totals in sync with the fixture problem count", () => {
    const total = DEV_MOCK_TEAM_VIEW.problems.length;
    for (const entry of DEV_MOCK_LEADERBOARD.entries) {
      expect(entry.totalProblems).toBe(total);
    }
  });

  it("should announce the trilogy in the notifications feed", () => {
    const bodies = DEV_MOCK_NOTIFICATIONS.items.map((n) => `${n.title} ${n.body}`).join("\n");
    expect(bodies).toContain("TenkaCloud を理解する");
    expect(bodies).toContain("ローカルモードで遊ぶ");
    expect(bodies).toContain("自分の TenkaCloud Lite を立てる");
  });
});
