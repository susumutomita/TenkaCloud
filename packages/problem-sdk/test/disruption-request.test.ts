import { describe, expect, it } from "vitest";
import { DisruptionFireRequestSchema } from "../src/disruption-request.js";

const teamRequest = {
  disruptionId: "frontend-down",
  problemId: "hello-world-battle",
  scope: "team",
  targetTeamIds: ["team-a"],
  requestId: "fire-team-a-1",
} as const;

describe("host disruption fire requests", () => {
  it("accepts an immediate request for one team by default", () => {
    expect(DisruptionFireRequestSchema.parse(teamRequest)).toEqual({
      ...teamRequest,
      timing: "immediate",
    });
  });

  it("accepts a scheduled all-team fire and a bounded recurring random selection", () => {
    expect(
      DisruptionFireRequestSchema.parse({
        ...teamRequest,
        scope: "all",
        targetTeamIds: undefined,
        timing: "scheduled",
        afterMinutes: 10,
      }),
    ).toMatchObject({ scope: "all", timing: "scheduled", afterMinutes: 10 });
    expect(
      DisruptionFireRequestSchema.parse({
        ...teamRequest,
        scope: "random-n",
        targetTeamIds: undefined,
        randomCount: 2,
        timing: "recurring",
        intervalMinutes: 5,
        maxFires: 3,
      }),
    ).toMatchObject({
      scope: "random-n",
      randomCount: 2,
      timing: "recurring",
      intervalMinutes: 5,
      maxFires: 3,
    });
  });

  it("rejects schedules, repeats, and target selections without their required fields", () => {
    for (const request of [
      { ...teamRequest, timing: "scheduled" },
      { ...teamRequest, timing: "recurring", intervalMinutes: 5 },
      { ...teamRequest, targetTeamIds: [] },
      { ...teamRequest, scope: "random-n", targetTeamIds: undefined },
      { ...teamRequest, scope: "all", afterMinutes: 5 },
    ]) {
      expect(DisruptionFireRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("rejects unknown request fields and unbounded repetition", () => {
    expect(
      DisruptionFireRequestSchema.safeParse({ ...teamRequest, targetRef: "forged" }).success,
    ).toBe(false);
    expect(
      DisruptionFireRequestSchema.safeParse({
        ...teamRequest,
        timing: "recurring",
        intervalMinutes: 1,
        maxFires: 61,
      }).success,
    ).toBe(false);
  });
});
