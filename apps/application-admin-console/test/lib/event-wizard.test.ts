import { describe, expect, it } from "vitest";
import { computeEventWizardState, WIZARD_STEPS } from "../../src/lib/event-wizard";

const NOW_MS = new Date("2026-05-11T12:00:00Z").getTime();

describe("computeEventWizardState", () => {
  it("should set primary=deploy with a 'press Deploy' CTA when status=DRAFT", () => {
    const out = computeEventWizardState({ status: "DRAFT" }, NOW_MS);
    expect(out.step).toBe("draft");
    expect(out.stepIndex).toBe(0);
    expect(out.primary).toBe("deploy");
    expect(out.cta).toMatch(/Deploy/);
    expect(out.alertType).toBe("info");
  });

  it("should set primary=null and include progress N/M in CTA when status=DEPLOYING", () => {
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

  it("should omit the N/M progress tail when DEPLOYING with no deployments yet", () => {
    // deploymentsByProblem 未提供 (= bulk deploy 直後で集計対象 0) のとき、 deploymentProgress
    // が {0,0,0} を返し total===0 → CTA の進捗 tail を出さない防御分岐。
    const out = computeEventWizardState({ status: "DEPLOYING" }, NOW_MS);
    expect(out.step).toBe("deploying");
    expect(out.cta).not.toMatch(/完了/);
  });

  it("should set primary=start and prompt to 'set the start time' when READY without startsAt", () => {
    const out = computeEventWizardState({ status: "READY" }, NOW_MS);
    expect(out.step).toBe("ready_unscheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBe("start");
    expect(out.cta).toMatch(/開始時刻/);
    expect(out.alertType).toBe("info");
  });

  it("should set primary=null and show the scheduled start when READY with future startsAt", () => {
    const future = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: future }, NOW_MS);
    expect(out.step).toBe("scheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBeNull();
    expect(out.cta).toContain(future);
    expect(out.alertType).toBe("success");
  });

  it("should set step=in_competition and primary=null when READY with past startsAt", () => {
    const past = new Date(NOW_MS - 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: past }, NOW_MS);
    expect(out.step).toBe("in_competition");
    expect(out.stepIndex).toBe(3);
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/競技中/);
    expect(out.alertType).toBe("success");
  });

  it("should set primary=delete and guide to 'Bulk Teardown' when status=ENDED", () => {
    const out = computeEventWizardState({ status: "ENDED" }, NOW_MS);
    expect(out.step).toBe("ended");
    expect(out.stepIndex).toBe(4);
    expect(out.primary).toBe("delete");
    expect(out.cta).toMatch(/Delete/);
    expect(out.alertType).toBe("info");
  });

  it("should set primary=null and show 'deleting' as warning when status=TEARDOWN", () => {
    const out = computeEventWizardState({ status: "TEARDOWN" }, NOW_MS);
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/削除中/);
    expect(out.alertType).toBe("warning");
  });

  it("should set primary=null and indicate 'read-only' when status=ARCHIVED", () => {
    const out = computeEventWizardState({ status: "ARCHIVED" }, NOW_MS);
    expect(out.step).toBe("archived");
    expect(out.primary).toBeNull();
    expect(out.cta).toMatch(/アーカイブ/);
  });

  it("should keep WIZARD_STEPS as 5 unique steps with a fixed order", () => {
    expect(WIZARD_STEPS).toHaveLength(5);
    const keys = WIZARD_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["draft", "deploying", "ready_unscheduled", "in_competition", "ended"]);
  });
});
