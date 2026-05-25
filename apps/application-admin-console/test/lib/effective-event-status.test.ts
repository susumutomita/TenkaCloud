import { describe, expect, it } from "vitest";
import { computeEffectiveStatus } from "../../src/lib/effective-event-status";

const PAST = "2026-05-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";
const NOW = new Date("2026-05-24T12:00:00Z");

describe("computeEffectiveStatus", () => {
  it("should return DRAFT when status=DRAFT regardless of times", () => {
    expect(computeEffectiveStatus({ status: "DRAFT" }, NOW)).toBe("DRAFT");
    expect(computeEffectiveStatus({ status: "DRAFT", startsAt: PAST }, NOW)).toBe("DRAFT");
    expect(computeEffectiveStatus({ status: "DRAFT", startsAt: PAST, endsAt: PAST }, NOW)).toBe(
      "DRAFT",
    );
  });

  it("should return DEPLOYING when status=DEPLOYING even after startsAt", () => {
    expect(
      computeEffectiveStatus({ status: "DEPLOYING", startsAt: PAST, endsAt: FUTURE }, NOW),
    ).toBe("DEPLOYING");
  });

  it("should return READY when status=READY without any times", () => {
    expect(computeEffectiveStatus({ status: "READY" }, NOW)).toBe("READY");
  });

  it("should return READY when status=READY and startsAt is in the future", () => {
    expect(computeEffectiveStatus({ status: "READY", startsAt: FUTURE }, NOW)).toBe("READY");
  });

  it("should return RUNNING when status=READY, startsAt past, endsAt future", () => {
    expect(computeEffectiveStatus({ status: "READY", startsAt: PAST, endsAt: FUTURE }, NOW)).toBe(
      "RUNNING",
    );
  });

  it("should return RUNNING when status=READY, startsAt past, endsAt null", () => {
    expect(computeEffectiveStatus({ status: "READY", startsAt: PAST }, NOW)).toBe("RUNNING");
    expect(computeEffectiveStatus({ status: "READY", startsAt: PAST, endsAt: null }, NOW)).toBe(
      "RUNNING",
    );
  });

  it("should return ENDED when status=READY, startsAt past, endsAt past", () => {
    expect(computeEffectiveStatus({ status: "READY", startsAt: PAST, endsAt: PAST }, NOW)).toBe(
      "ENDED",
    );
  });

  it("should return ENDED when status=READY, endsAt past (without startsAt)", () => {
    expect(computeEffectiveStatus({ status: "READY", endsAt: PAST }, NOW)).toBe("ENDED");
  });

  it("should treat endsAt equal to now as ENDED (boundary)", () => {
    const exact = NOW.toISOString();
    expect(computeEffectiveStatus({ status: "READY", endsAt: exact }, NOW)).toBe("ENDED");
  });

  it("should treat startsAt equal to now as RUNNING (boundary)", () => {
    const exact = NOW.toISOString();
    expect(computeEffectiveStatus({ status: "READY", startsAt: exact }, NOW)).toBe("RUNNING");
  });

  it("should return ENDED when status=ENDED regardless of times", () => {
    expect(computeEffectiveStatus({ status: "ENDED", startsAt: FUTURE, endsAt: FUTURE }, NOW)).toBe(
      "ENDED",
    );
  });

  it("should return TEARDOWN when status=TEARDOWN regardless of times", () => {
    expect(
      computeEffectiveStatus({ status: "TEARDOWN", startsAt: PAST, endsAt: FUTURE }, NOW),
    ).toBe("TEARDOWN");
    expect(computeEffectiveStatus({ status: "TEARDOWN" }, NOW)).toBe("TEARDOWN");
  });

  it("should return ARCHIVED when status=ARCHIVED regardless of times", () => {
    expect(computeEffectiveStatus({ status: "ARCHIVED", startsAt: PAST, endsAt: PAST }, NOW)).toBe(
      "ARCHIVED",
    );
    expect(computeEffectiveStatus({ status: "ARCHIVED" }, NOW)).toBe("ARCHIVED");
  });

  it("should sync with Phase indicator: status=READY + startsAt past + endsAt future → RUNNING", () => {
    // Phase indicator (= computeEventWizardState) では同条件で stepIndex=3 (= 「競技中」) になる。
    // ここでの effective status も RUNNING を返すことで badge と Phase が同期する (#1330)。
    const effective = computeEffectiveStatus(
      { status: "READY", startsAt: PAST, endsAt: FUTURE },
      NOW,
    );
    expect(effective).toBe("RUNNING");
  });

  it("should default the `now` argument to current time when omitted", () => {
    // PAST < Date.now() なので RUNNING になるはず。
    expect(computeEffectiveStatus({ status: "READY", startsAt: PAST })).toBe("RUNNING");
  });
});
