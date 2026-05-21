import { describe, expect, it } from "vitest";
import {
  aggregateDeployProgressPercent,
  deploymentProgressWeight,
} from "../../src/lib/deploy-progress";

describe("deploymentProgressWeight", () => {
  it("should return 5% for a freshly queued PENDING deployment", () => {
    expect(deploymentProgressWeight("PENDING")).toBe(5);
  });

  it("should return 50% for a mid-flight IN_PROGRESS deployment", () => {
    expect(deploymentProgressWeight("IN_PROGRESS")).toBe(50);
  });

  it("should return 80% for a DELETING deployment (mostly torn down)", () => {
    expect(deploymentProgressWeight("DELETING")).toBe(80);
  });

  it("should return 100% for every terminal status", () => {
    for (const s of ["COMPLETE", "FAILED", "DELETED", "EXPIRED", "AUTO_DELETED"] as const) {
      expect(deploymentProgressWeight(s)).toBe(100);
    }
  });
});

describe("aggregateDeployProgressPercent", () => {
  it("should return 0 when no deployments exist", () => {
    expect(aggregateDeployProgressPercent([])).toBe(0);
  });

  it("should reflect single-deployment mid-flight progress (not 0/100 binary) — fixes user-reported binary progress bar", () => {
    expect(aggregateDeployProgressPercent(["PENDING"])).toBe(5);
    expect(aggregateDeployProgressPercent(["IN_PROGRESS"])).toBe(50);
    expect(aggregateDeployProgressPercent(["DELETING"])).toBe(80);
    expect(aggregateDeployProgressPercent(["COMPLETE"])).toBe(100);
  });

  it("should average per-deployment weights when multiple deployments mix states", () => {
    // 2 done + 2 mid-flight = (100 + 100 + 50 + 50) / 4 = 75
    expect(
      aggregateDeployProgressPercent(["COMPLETE", "COMPLETE", "IN_PROGRESS", "IN_PROGRESS"]),
    ).toBe(75);
    // 1 queued + 1 in-flight + 1 done = (5 + 50 + 100) / 3 ≈ 52
    expect(aggregateDeployProgressPercent(["PENDING", "IN_PROGRESS", "COMPLETE"])).toBe(52);
  });

  it("should return 100 when every deployment is terminal", () => {
    expect(aggregateDeployProgressPercent(["COMPLETE", "FAILED", "AUTO_DELETED"])).toBe(100);
  });
});
