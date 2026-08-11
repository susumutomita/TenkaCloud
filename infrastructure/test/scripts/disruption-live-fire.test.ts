import { describe, expect, it } from "vitest";
import {
  assessLiveFire,
  buildFireRequest,
  classifySample,
  evaluateFaultTimeline,
  type HealthSample,
} from "../../../scripts/lib/disruption-live-fire";

/**
 * [Issue #1419 / #1666] AWS disruption live-fire — pure logic pin.
 *
 * Verifies the account-free core: the fire request matches DisruptionFireRequestSchema's constraints,
 * and the timeline judge reduces a health series to the acceptance verdict (observable fault that
 * auto-reverts within the window). The live network send is the only account-gated part.
 */

describe("buildFireRequest (schema parity)", () => {
  const base = {
    problemId: "security-battle-royale",
    disruptionId: "availability-flood",
    requestId: "live-fire-abcd1234",
  };

  it("should build a team-scoped fire body with targetTeamIds", () => {
    const body = buildFireRequest({ ...base, scope: "team", targetTeamIds: ["team-1"] });
    expect(body).toEqual({
      problemId: "security-battle-royale",
      disruptionId: "availability-flood",
      scope: "team",
      targetTeamIds: ["team-1"],
      requestId: "live-fire-abcd1234",
    });
  });

  it("should throw when requestId is shorter than 8 chars (idempotency key)", () => {
    expect(() => buildFireRequest({ ...base, requestId: "short", scope: "all" })).toThrow(/8–128/);
  });

  it("should require targetTeamIds for scope=team", () => {
    expect(() => buildFireRequest({ ...base, scope: "team" })).toThrow(/targetTeamIds is required/);
  });

  it("should require randomCount for scope=random-n", () => {
    expect(() => buildFireRequest({ ...base, scope: "random-n" })).toThrow(
      /randomCount is required/,
    );
  });
});

describe("classifySample", () => {
  it("should mark a 200 healthy and a null (timeout) unhealthy", () => {
    expect(classifySample(1, 200, [200]).healthy).toBe(true);
    expect(classifySample(2, 503, [200]).healthy).toBe(false);
    expect(classifySample(3, null, [200]).healthy).toBe(false);
  });
});

const FIRED = 1000;
const sample = (atMs: number, healthy: boolean): HealthSample => ({
  atMs,
  status: healthy ? 200 : 503,
  healthy,
});

describe("evaluateFaultTimeline + assessLiveFire (#1419/#1666 acceptance)", () => {
  it("should PASS a healthy → faulted → recovered timeline within the window", () => {
    const samples = [
      sample(900, true), // baseline (before fire)
      sample(1200, false), // fault onset after fire
      sample(1400, false),
      sample(1600, true), // recovery
    ];
    const timeline = evaluateFaultTimeline(samples, FIRED);
    expect(timeline).toMatchObject({
      baselineHealthy: true,
      faulted: true,
      recovered: true,
      faultDurationMs: 400,
    });
    expect(assessLiveFire(timeline, { maxRecoveryMs: 1000 }).verdict).toBe("pass");
  });

  it("should report no-fault when the target never goes unhealthy (the 'no real fault' symptom)", () => {
    const timeline = evaluateFaultTimeline(
      [sample(900, true), sample(1200, true), sample(1600, true)],
      FIRED,
    );
    expect(timeline.faulted).toBe(false);
    expect(assessLiveFire(timeline, { maxRecoveryMs: 1000 }).verdict).toBe("no-fault");
  });

  it("should report no-recovery when automatic revert never restores the target", () => {
    const timeline = evaluateFaultTimeline(
      [sample(900, true), sample(1200, false), sample(1600, false)],
      FIRED,
    );
    expect(timeline).toMatchObject({ faulted: true, recovered: false });
    expect(assessLiveFire(timeline, { maxRecoveryMs: 1000 }).verdict).toBe("no-recovery");
  });

  it("should report no-recovery when recovery is beyond the window", () => {
    const timeline = evaluateFaultTimeline(
      [sample(900, true), sample(1100, false), sample(5000, true)],
      FIRED,
    );
    expect(timeline.faultDurationMs).toBe(3900);
    expect(assessLiveFire(timeline, { maxRecoveryMs: 1000 }).verdict).toBe("no-recovery");
  });

  it("should report no-baseline when the target was already unhealthy before the fire", () => {
    const timeline = evaluateFaultTimeline(
      [sample(900, false), sample(1200, false), sample(1600, true)],
      FIRED,
    );
    expect(timeline.baselineHealthy).toBe(false);
    expect(assessLiveFire(timeline, { maxRecoveryMs: 1000 }).verdict).toBe("no-baseline");
  });
});
