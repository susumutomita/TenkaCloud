import { describe, expect, it } from "vitest";
import {
  type ApplicationStatus,
  PortalScoringGateError,
  PortalValidationError,
  type SubmitFlagOutcome,
} from "../api/portal-client";
import {
  describeApplicationStatus,
  formatProblemPanelActionError,
  shouldRefreshAfterFlagSubmit,
} from "./ProblemPanel.helpers";

// `t` echoes the key (+ params) so each branch is identifiable by its returned key.
const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const VKEY = "problem_panel.validation_error" as const;
const fmt = (err: unknown) => formatProblemPanelActionError(t, err, VKEY);

describe("formatProblemPanelActionError — scoring gate", () => {
  it("should describe scoring_not_started without an ETA", () => {
    expect(fmt(new PortalScoringGateError("scoring_not_started"))).toBe(
      "problem_panel.scoring_gate_not_started_no_eta",
    );
  });

  it("should describe scoring_not_started with an unparseable startsAt", () => {
    expect(fmt(new PortalScoringGateError("scoring_not_started", "not-a-date"))).toBe(
      "problem_panel.scoring_gate_not_started_unknown",
    );
  });

  it("should describe scoring_not_started whose startsAt has already passed", () => {
    expect(
      fmt(new PortalScoringGateError("scoring_not_started", "2020-01-01T00:00:00.000Z")),
    ).toContain("problem_panel.scoring_gate_not_started_passed");
  });

  it("should describe scoring_not_started with remaining minutes when startsAt is in the future", () => {
    const out = fmt(new PortalScoringGateError("scoring_not_started", "2999-01-01T00:00:00.000Z"));
    expect(out).toContain("problem_panel.scoring_gate_not_started_remaining");
    expect(out).toContain("minutes");
  });

  it("should describe scoring_ended (no / invalid / valid endsAt)", () => {
    expect(fmt(new PortalScoringGateError("scoring_ended"))).toBe(
      "problem_panel.scoring_gate_ended_no_eta",
    );
    expect(fmt(new PortalScoringGateError("scoring_ended", undefined, "nope"))).toBe(
      "problem_panel.scoring_gate_ended_unknown",
    );
    expect(
      fmt(new PortalScoringGateError("scoring_ended", undefined, "2026-05-15T00:00:00.000Z")),
    ).toContain("problem_panel.scoring_gate_ended_at");
  });

  it("should describe a locked gate as paused", () => {
    expect(fmt(new PortalScoringGateError("scoring_locked"))).toBe(
      "problem_panel.scoring_gate_paused",
    );
  });
});

describe("formatProblemPanelActionError — non-gate errors", () => {
  it("should map a PortalValidationError to the validation key with its errorCode", () => {
    expect(fmt(new PortalValidationError("flag_too_long"))).toContain(VKEY);
  });

  it("should fall back to the Error message, then String() for unknowns", () => {
    expect(fmt(new Error("boom"))).toBe("boom");
    expect(fmt("weird")).toBe("weird");
  });
});

describe("shouldRefreshAfterFlagSubmit", () => {
  it("should refresh on ok / already_scored and not otherwise", () => {
    expect(shouldRefreshAfterFlagSubmit({ kind: "ok" } as SubmitFlagOutcome)).toBe(true);
    expect(shouldRefreshAfterFlagSubmit({ kind: "already_scored" } as SubmitFlagOutcome)).toBe(
      true,
    );
    expect(shouldRefreshAfterFlagSubmit({ kind: "wrong" } as SubmitFlagOutcome)).toBe(false);
  });
});

describe("describeApplicationStatus (#1917)", () => {
  const status = (over: Partial<ApplicationStatus>): ApplicationStatus => ({
    overall: "healthy",
    healthyCount: 1,
    totalCount: 1,
    ...over,
  });

  it("should map each overall to its StatusIndicator type", () => {
    expect(describeApplicationStatus(status({ overall: "healthy" }), t).type).toBe("success");
    expect(describeApplicationStatus(status({ overall: "degraded" }), t).type).toBe("warning");
    expect(describeApplicationStatus(status({ overall: "down" }), t).type).toBe("error");
    expect(describeApplicationStatus(status({ overall: "unknown" }), t).type).toBe("pending");
  });

  it("should label the health with the passing/total counts", () => {
    const out = describeApplicationStatus(
      status({ overall: "degraded", healthyCount: 2, totalCount: 5 }),
      t,
    );
    expect(out.label).toContain("problem_panel.health_degraded");
    expect(out.label).toContain('"healthy":2');
    expect(out.label).toContain('"total":5');
  });
});
