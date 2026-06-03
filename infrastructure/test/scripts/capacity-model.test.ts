import { describe, expect, it } from "vitest";
import {
  type CapacityInputs,
  DEFAULT_CAPACITY_INPUTS,
  maxTeamsBeforeThrottle,
  modelDeploymentsTable,
} from "../../../scripts/lib/capacity-model";

/**
 * [Issue #1667] DynamoDB capacity model — pins the scoring-loop arithmetic and the throttle
 * point so the "how many teams before 1/1 throttles?" answer is regression-guarded.
 */

const base = (over: Partial<CapacityInputs> = {}): CapacityInputs => ({
  ...DEFAULT_CAPACITY_INPUTS,
  teams: 10,
  ...over,
});

describe("modelDeploymentsTable (#1667)", () => {
  it("should compute the exact scoring-loop load for 10 teams × 3 problems", () => {
    const m = modelDeploymentsTable(base({ teams: 10 }));
    expect(m.deployments).toBe(30);
    expect(m.scoringScanReadsPerSec).toBeCloseTo(0.5); // 30 items / 60s tick
    expect(m.scoringWritesPerSec).toBeCloseTo(1.0); // 30 deployments × 2 writes / 60s
    expect(m.participantReadsPerSec).toBeCloseTo(2.0); // (20 participants × 1 × 3) / 30s poll
    expect(m.totalReadsPerSec).toBeCloseTo(2.5);
    expect(m.readCapacityUnits).toBeCloseTo(1.25); // eventually-consistent (÷2)
    expect(m.writeCapacityUnits).toBeCloseTo(1.0);
  });

  it("should flag a read-throttle at 10 teams but not a write-throttle (WCU exactly at ceiling)", () => {
    const m = modelDeploymentsTable(base({ teams: 10 }));
    expect(m.readThrottles).toBe(true); // 1.25 RCU > 1
    expect(m.writeThrottles).toBe(false); // 1.0 WCU is at, not over, the ceiling
  });

  it("should not throttle at 5 teams", () => {
    const m = modelDeploymentsTable(base({ teams: 5 }));
    expect(m.readThrottles).toBe(false);
    expect(m.writeThrottles).toBe(false);
  });
});

describe("maxTeamsBeforeThrottle (#1667)", () => {
  it("should report ~8 teams (read-limited) under the default poll assumptions", () => {
    expect(maxTeamsBeforeThrottle(DEFAULT_CAPACITY_INPUTS)).toEqual({
      maxTeams: 8,
      limiting: "read",
    });
  });

  it("should become write-limited at 10 teams when participant reads are excluded", () => {
    // deploymentsReadsPerPoll=0 → only the scoring loop reads (tiny); the WCU ceiling binds first.
    expect(
      maxTeamsBeforeThrottle({ ...DEFAULT_CAPACITY_INPUTS, deploymentsReadsPerPoll: 0 }),
    ).toEqual({ maxTeams: 10, limiting: "write" });
  });

  it("should report 'none' when nothing throttles within the search range", () => {
    expect(maxTeamsBeforeThrottle(DEFAULT_CAPACITY_INPUTS, 2)).toEqual({
      maxTeams: 2,
      limiting: "none",
    });
  });
});
