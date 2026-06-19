import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_RESOURCE_TYPES,
  analyzeProblemCost,
  parseEstimatedDurationHours,
} from "../../../scripts/lib/problem-cost";
import { runCost } from "../../../scripts/tenkacloud-problem";

describe("problem cost model", () => {
  it("should estimate always-on resources and flag large EC2 instances", () => {
    const estimate = analyzeProblemCost(
      `Resources:
  Mystery:
    Type: AWS::MadeUp::Widget
  Nat:
    Type: AWS::EC2::NatGateway
  Runner:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.large
`,
      "60〜90 分",
    );

    expect(ALWAYS_ON_RESOURCE_TYPES).toContain("AWS::EC2::NatGateway");
    expect(estimate.sessionHours).toBe(1.25);
    expect(estimate.resources.map((resource) => resource.logicalId)).toEqual([
      "Mystery",
      "Nat",
      "Runner",
    ]);
    expect(estimate.resources.find((resource) => resource.logicalId === "Runner")).toMatchObject({
      roughHourlyUsd: 0.0832,
      riskLevel: "high",
      alwaysOn: true,
    });
    expect(estimate.alwaysOnWarnings.map((resource) => resource.logicalId)).toEqual([
      "Nat",
      "Runner",
    ]);
    expect(estimate.unpricedResourceTypes).toEqual(["AWS::MadeUp::Widget"]);
    expect(estimate.perSessionUsd).toBeCloseTo(0.16025, 5);
    expect(estimate.perDayIfLeftRunningUsd).toBeCloseTo(3.0768, 5);
  });

  it("should parse common estimatedDuration strings", () => {
    expect(parseEstimatedDurationHours("30 分")).toBe(0.5);
    expect(parseEstimatedDurationHours("60〜90 分")).toBe(1.25);
    expect(parseEstimatedDurationHours("1h 30m")).toBe(1.5);
    expect(parseEstimatedDurationHours("2 hours")).toBe(2);
    expect(parseEstimatedDurationHours("workshop")).toBeUndefined();
  });
});

describe("tenkacloud-problem cost", () => {
  it("should print a cost report for an existing problem", () => {
    const result = runCost({ problemId: "hello-world" });

    expect(result.ok).toBe(true);
    const text = result.lines.join("\n");
    expect(text).toContain("=== Cost estimate hello-world ===");
    expect(text).toContain("Resources:");
    expect(text).toContain("Totals:");
    expect(result.summary).toContain("hello-world:");
  });

  it("should return ok=false for a missing problem", () => {
    const result = runCost({ problemId: "missing-problem" });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("problemId not found");
  });
});
