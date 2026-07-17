import { LITE_DRILL_CHECKPOINTS, LITE_DRILL_PROBLEM_ID } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";

/**
 * Issue #2696: LP デモの固定出題 (2 クエスト + Lite deploy ドリル) の整合性を pin する。
 * ドリルの sub-flag id は `@tenkacloud/portal-contracts` の lite-drill 契約と一致して
 * いなければ、 dev-mock 判定 (`evaluateMockSubFlag`) が永遠に wrong を返す。
 */
describe("dev-mock fixtures", () => {
  const drill = DEV_MOCK_TEAM_VIEW.problems.find((p) => p.problemId === LITE_DRILL_PROBLEM_ID);

  it("should include the Lite deploy drill as an unsolved multi-flag problem", () => {
    expect(drill).toBeDefined();
    expect(drill?.scoring?.kind).toBe("multi-flag");
    expect(drill?.score).toBe(0);
    expect(drill?.scoring?.flags?.every((f) => !f.solved)).toBe(true);
  });

  it("should keep the drill sub-flag ids aligned with the lite-drill contract, in journey order", () => {
    const expectedOrder = [
      LITE_DRILL_CHECKPOINTS.launcherCreated.flagId,
      LITE_DRILL_CHECKPOINTS.deployComplete.flagId,
      LITE_DRILL_CHECKPOINTS.competitorVerified.flagId,
      LITE_DRILL_CHECKPOINTS.firstEventCreated.flagId,
    ];
    expect(drill?.scoring?.flags?.map((f) => f.id)).toEqual(expectedOrder);
  });

  it("should give every drill step positive points and an English label", () => {
    for (const flag of drill?.scoring?.flags ?? []) {
      expect(flag.points).toBeGreaterThan(0);
      expect(flag.i18n?.en?.label).toBeTruthy();
    }
  });

  it("should ship the drill narrative in both Japanese and English", () => {
    expect(drill?.name).toBeTruthy();
    expect(drill?.description).toBeTruthy();
    expect(drill?.instructions).toBeTruthy();
    expect(drill?.i18n?.en?.name).toBeTruthy();
    expect(drill?.i18n?.en?.description).toBeTruthy();
    expect(drill?.i18n?.en?.instructions).toBeTruthy();
  });

  it("should keep the leaderboard problem totals in sync with the fixture problem count", () => {
    const total = DEV_MOCK_TEAM_VIEW.problems.length;
    for (const entry of DEV_MOCK_LEADERBOARD.entries) {
      expect(entry.totalProblems).toBe(total);
    }
  });

  it("should announce the drill in the notifications feed", () => {
    const bodies = DEV_MOCK_NOTIFICATIONS.items.map((n) => `${n.title} ${n.body}`).join("\n");
    expect(bodies).toContain("自分の TenkaCloud Lite を立てる");
  });
});
