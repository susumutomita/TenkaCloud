import { describe, expect, it } from "vitest";
import { describeTrigger, describeTriggers } from "./disruption-triggers";

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

describe("describeTrigger", () => {
  it("should describe an after-deploy trigger with its minutes", () => {
    expect(describeTrigger({ kind: "after-deploy", afterMinutes: 30 }, t)).toBe(
      'disruptions.trigger_after_deploy|{"minutes":30}',
    );
  });

  it("should describe a team-score-above trigger with its threshold", () => {
    expect(describeTrigger({ kind: "team-score-above", threshold: 5000 }, t)).toBe(
      'disruptions.trigger_score_above|{"threshold":5000}',
    );
  });

  it("should describe a phase-entered trigger with its phase name", () => {
    expect(describeTrigger({ kind: "phase-entered", phaseName: "hardening" }, t)).toBe(
      'disruptions.trigger_phase_entered|{"phase":"hardening"}',
    );
  });
});

describe("describeTriggers", () => {
  it("should map every declared trigger to a label", () => {
    expect(
      describeTriggers(
        [
          { kind: "after-deploy", afterMinutes: 10 },
          { kind: "team-score-above", threshold: 100 },
        ],
        t,
      ),
    ).toHaveLength(2);
  });

  it("should return an empty list for undefined or empty triggers (manual fire only)", () => {
    expect(describeTriggers(undefined, t)).toEqual([]);
    expect(describeTriggers([], t)).toEqual([]);
  });
});
