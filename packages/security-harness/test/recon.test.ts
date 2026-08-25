import { describe, expect, it } from "vitest";
import { planRecon } from "../src/recon.js";
import type { ReconThreatModel } from "../src/recon.js";

const THREAT_MODEL: ReconThreatModel = {
  threatModelDigest: "sha256:abc",
  focusAreas: [
    { id: "auth", description: "authentication bypass", priority: 1 },
    { id: "idor", description: "insecure direct object reference", priority: 3 },
    { id: "injection", description: "injection", priority: 2 },
  ],
};

describe("planRecon: focus-area partition", () => {
  it("should assign one primary finder per focus area, highest priority first, when finders exactly match focus areas", () => {
    const plan = planRecon(THREAT_MODEL, 3);
    expect(plan.assignments).toEqual([
      { finderIndex: 0, focusArea: "idor" },
      { finderIndex: 1, focusArea: "injection" },
      { finderIndex: 2, focusArea: "auth" },
    ]);
    expect(plan.uncoveredFocusAreaIds).toEqual([]);
  });

  it("should report uncovered focus areas, never silently merging two areas into one finder", () => {
    const plan = planRecon(THREAT_MODEL, 2);
    expect(plan.assignments).toEqual([
      { finderIndex: 0, focusArea: "idor" },
      { finderIndex: 1, focusArea: "injection" },
    ]);
    expect(plan.uncoveredFocusAreaIds).toEqual(["auth"]);
  });

  it("should break priority ties by declaration order, deterministically", () => {
    const tied: ReconThreatModel = {
      threatModelDigest: "sha256:tie",
      focusAreas: [
        { id: "first", description: "d", priority: 5 },
        { id: "second", description: "d", priority: 5 },
      ],
    };
    const plan = planRecon(tied, 2);
    expect(plan.assignments.map((a) => a.focusArea)).toEqual(["first", "second"]);
  });

  it("should give spare finder slots a round-robin second pass over the highest-priority areas, never leaving a finder idle", () => {
    const plan = planRecon(THREAT_MODEL, 5);
    expect(plan.assignments).toEqual([
      { finderIndex: 0, focusArea: "idor" },
      { finderIndex: 1, focusArea: "injection" },
      { finderIndex: 2, focusArea: "auth" },
      { finderIndex: 3, focusArea: "idor" },
      { finderIndex: 4, focusArea: "injection" },
    ]);
    expect(plan.uncoveredFocusAreaIds).toEqual([]);
  });

  it("should produce zero assignments and report every focus area as uncovered when maxFinders is zero", () => {
    const plan = planRecon(THREAT_MODEL, 0);
    expect(plan.assignments).toEqual([]);
    expect(plan.uncoveredFocusAreaIds).toEqual(["auth", "idor", "injection"]);
  });

  it("should produce zero assignments and no uncovered areas when the threat model declares none", () => {
    const empty: ReconThreatModel = { threatModelDigest: "sha256:empty", focusAreas: [] };
    const plan = planRecon(empty, 4);
    expect(plan.assignments).toEqual([]);
    expect(plan.uncoveredFocusAreaIds).toEqual([]);
  });

  it("should be deterministic across repeated calls with the same input", () => {
    const first = planRecon(THREAT_MODEL, 5);
    const second = planRecon(THREAT_MODEL, 5);
    expect(first).toEqual(second);
  });

  it("should carry the threat model digest and maxFinders through unchanged", () => {
    const plan = planRecon(THREAT_MODEL, 2);
    expect(plan.threatModelDigest).toBe("sha256:abc");
    expect(plan.maxFinders).toBe(2);
  });
});
