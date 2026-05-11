import { describe, expect, it } from "vitest";
import { computeEventWizardState, WIZARD_STEPS } from "../../src/lib/event-wizard";

const NOW_MS = new Date("2026-05-11T12:00:00Z").getTime();

describe("computeEventWizardState", () => {
  it("DRAFT のとき primary=deploy で「Deploy を押せ」を CTA に出すべき", () => {
    const out = computeEventWizardState({ status: "DRAFT" }, NOW_MS);
    expect(out.step).toBe("draft");
    expect(out.stepIndex).toBe(0);
    expect(out.primary).toBe("deploy");
    expect(out.cta).toMatch(/Deploy/);
    expect(out.alertType).toBe("info");
  });

  it("DEPLOYING のとき primary=null で進捗 N/M を CTA に含めるべき", () => {
    const out = computeEventWizardState(
      {
        status: "DEPLOYING",
        deploymentsByProblem: {
          p1: [
            { jobId: "j1", teamId: "t1", status: "COMPLETE" },
            { jobId: "j2", teamId: "t2", status: "IN_PROGRESS" },
          ],
          p2: [{ jobId: "j3", teamId: "t1", status: "PENDING" }],
        },
      },
      NOW_MS,
    );
    expect(out.step).toBe("deploying");
    expect(out.stepIndex).toBe(1);
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/1 \/ 3/);
    expect(out.cta).toMatch(/失敗 0/);
    expect(out.alertType).toBe("success");
  });

  it("READY + startsAt なしのとき primary=start で「開始時刻を設定」を促すべき", () => {
    const out = computeEventWizardState({ status: "READY" }, NOW_MS);
    expect(out.step).toBe("ready_unscheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBe("start");
    expect(out.cta).toMatch(/開始時刻/);
    expect(out.alertType).toBe("info");
  });

  it("READY + startsAt 未来のとき primary=null で開始予定を示すべき", () => {
    const future = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: future }, NOW_MS);
    expect(out.step).toBe("scheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBeNull();
    expect(out.cta).toContain(future);
    expect(out.alertType).toBe("success");
  });

  it("READY + startsAt 過去のとき step=in_competition で primary=null になるべき", () => {
    const past = new Date(NOW_MS - 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: past }, NOW_MS);
    expect(out.step).toBe("in_competition");
    expect(out.stepIndex).toBe(3);
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/競技中/);
    expect(out.alertType).toBe("success");
  });

  it("ENDED のとき primary=delete で「Bulk Teardown を案内」すべき", () => {
    const out = computeEventWizardState({ status: "ENDED" }, NOW_MS);
    expect(out.step).toBe("ended");
    expect(out.stepIndex).toBe(4);
    expect(out.primary).toBe("delete");
    expect(out.cta).toMatch(/Delete/);
    expect(out.alertType).toBe("info");
  });

  it("TEARDOWN のとき primary=null で「削除中」を warning で表示すべき", () => {
    const out = computeEventWizardState({ status: "TEARDOWN" }, NOW_MS);
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/削除中/);
    expect(out.alertType).toBe("warning");
  });

  it("ARCHIVED のとき primary=null で「閲覧のみ」と示すべき", () => {
    const out = computeEventWizardState({ status: "ARCHIVED" }, NOW_MS);
    expect(out.step).toBe("archived");
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/アーカイブ/);
  });

  it("WIZARD_STEPS は重複なしの 5 段で順序固定であるべき", () => {
    expect(WIZARD_STEPS).toHaveLength(5);
    const keys = WIZARD_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["draft", "deploying", "ready_unscheduled", "in_competition", "ended"]);
  });
});
