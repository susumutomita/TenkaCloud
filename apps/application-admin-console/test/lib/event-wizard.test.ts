import { describe, expect, it } from "vitest";
import { computeEventWizardState, WIZARD_STEPS } from "../../src/lib/event-wizard";

const NOW_MS = new Date("2026-05-11T12:00:00Z").getTime();

describe("computeEventWizardState", () => {
  it("should set step=draft, stepIndex=0, primary=deploy when status=DRAFT", () => {
    const out = computeEventWizardState({ status: "DRAFT" }, NOW_MS);
    expect(out.step).toBe("draft");
    expect(out.stepIndex).toBe(0);
    expect(out.primary).toBe("deploy");
  });

  it("should set step=deploying, stepIndex=1, primary=null when status=DEPLOYING", () => {
    const out = computeEventWizardState({ status: "DEPLOYING" }, NOW_MS);
    expect(out.step).toBe("deploying");
    expect(out.stepIndex).toBe(1);
    expect(out.primary).toBeNull();
  });

  it("should set step=ready_unscheduled, primary=start when READY without startsAt", () => {
    const out = computeEventWizardState({ status: "READY" }, NOW_MS);
    expect(out.step).toBe("ready_unscheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBe("start");
  });

  it("should set step=scheduled, primary=null when READY with future startsAt", () => {
    const future = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: future }, NOW_MS);
    expect(out.step).toBe("scheduled");
    expect(out.stepIndex).toBe(2);
    expect(out.primary).toBeNull();
  });

  it("should set step=in_competition, stepIndex=3, primary=null when READY with past startsAt", () => {
    const past = new Date(NOW_MS - 60 * 1000).toISOString();
    const out = computeEventWizardState({ status: "READY", startsAt: past }, NOW_MS);
    expect(out.step).toBe("in_competition");
    expect(out.stepIndex).toBe(3);
    expect(out.primary).toBeNull();
  });

  it("should set step=ended, stepIndex=4, primary=delete when status=ENDED", () => {
    const out = computeEventWizardState({ status: "ENDED" }, NOW_MS);
    expect(out.step).toBe("ended");
    expect(out.stepIndex).toBe(4);
    expect(out.primary).toBe("delete");
  });

  it("should set step=ended, primary=null when status=TEARDOWN", () => {
    const out = computeEventWizardState({ status: "TEARDOWN" }, NOW_MS);
    expect(out.step).toBe("ended");
    expect(out.primary).toBeNull();
  });

  it("should set step=archived, primary=null when status=ARCHIVED", () => {
    const out = computeEventWizardState({ status: "ARCHIVED" }, NOW_MS);
    expect(out.step).toBe("archived");
    expect(out.primary).toBeNull();
  });

  it("should keep WIZARD_STEPS as 5 unique steps with a fixed order", () => {
    expect(WIZARD_STEPS).toHaveLength(5);
    const keys = WIZARD_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["draft", "deploying", "ready_unscheduled", "in_competition", "ended"]);
  });
});
