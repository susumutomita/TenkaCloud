import { describe, expect, it } from "vitest";
import { analyzeProblemCost, formatUsd, parseEstimatedDurationHours } from "../src/index";

/**
 * Issue #2215: this module had zero dedicated tests before the packages/ move (it was only
 * exercised indirectly through apps/application-admin-console's ProblemCostSummary component
 * test). Pins the public API's behavior directly.
 */

const cfnTemplate = (resources: string) => `
Resources:
${resources}
`;

describe("analyzeProblemCost", () => {
  it("should cost a known always-on resource and sum totals", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Table:
    Type: AWS::DynamoDB::Table
    Properties: {}
`),
    );
    expect(estimate.resources).toHaveLength(1);
    expect(estimate.resources[0]).toMatchObject({
      logicalId: "Table",
      resourceType: "AWS::DynamoDB::Table",
      roughHourlyUsd: 0.00078,
      alwaysOn: true,
      riskLevel: "low",
    });
    expect(estimate.totalHourlyUsd).toBeCloseTo(0.00078);
    expect(estimate.alwaysOnHourlyUsd).toBeCloseTo(0.00078);
    expect(estimate.perDayIfLeftRunningUsd).toBeCloseTo(0.00078 * 24);
  });

  it("should not count a zero-hourly always-on resource as an alwaysOnWarning", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Vpc:
    Type: AWS::EC2::VPC
    Properties: {}
`),
    );
    expect(estimate.alwaysOnWarnings).toHaveLength(0);
    expect(estimate.totalHourlyUsd).toBe(0);
  });

  it("should override the EC2 hourly cost by InstanceType and flag large instances as high risk", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Server:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: m5.xlarge
`),
    );
    expect(estimate.resources[0]).toMatchObject({
      roughHourlyUsd: 0.192,
      riskLevel: "high",
      notes: expect.arrayContaining(["InstanceType=m5.xlarge"]),
    });
  });

  it("should fall back to the default EC2 estimate when InstanceType is a dynamic CFn intrinsic", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Server:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref InstanceTypeParam
`),
    );
    expect(estimate.resources[0]?.roughHourlyUsd).toBe(0.0104);
    expect(estimate.resources[0]?.notes.some((n) => n.includes("InstanceType is dynamic"))).toBe(
      true,
    );
  });

  it("should mark a resource type with no heuristic as unpriced/unknown", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Mystery:
    Type: AWS::Made::UpType
    Properties: {}
`),
    );
    expect(estimate.resources[0]?.riskLevel).toBe("unknown");
    expect(estimate.unpricedResourceTypes).toEqual(["AWS::Made::UpType"]);
  });

  it("should treat Custom:: resources as invocation-time (no standing cost)", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Setup:
    Type: Custom::Bootstrap
    Properties: {}
`),
    );
    expect(estimate.resources[0]).toMatchObject({ roughHourlyUsd: 0, riskLevel: "low" });
    expect(estimate.unpricedResourceTypes).toEqual([]);
  });

  it("should sort resources by logicalId and compute perSessionUsd from estimatedDuration", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Zebra:
    Type: AWS::EC2::NatGateway
    Properties: {}
  Alpha:
    Type: AWS::DynamoDB::Table
    Properties: {}
`),
      "2 hours",
    );
    expect(estimate.resources.map((r) => r.logicalId)).toEqual(["Alpha", "Zebra"]);
    expect(estimate.sessionHours).toBe(2);
    expect(estimate.perSessionUsd).toBeCloseTo(estimate.totalHourlyUsd * 2);
  });

  it("should leave sessionHours/perSessionUsd undefined without estimatedDuration", () => {
    const estimate = analyzeProblemCost(cfnTemplate(`  Table:\n    Type: AWS::DynamoDB::Table\n`));
    expect(estimate.sessionHours).toBeUndefined();
    expect(estimate.perSessionUsd).toBeUndefined();
  });

  it("should ignore a non-object Resources section and non-object resource entries", () => {
    const estimate = analyzeProblemCost("Resources: not-an-object");
    expect(estimate.resources).toEqual([]);
  });
});

describe("parseEstimatedDurationHours", () => {
  it("should parse combined hour+minute forms", () => {
    expect(parseEstimatedDurationHours("1h30m")).toBeCloseTo(1.5);
    expect(parseEstimatedDurationHours("2時間30分")).toBeCloseTo(2.5);
  });

  it("should average multiple numbers and apply the hour unit", () => {
    expect(parseEstimatedDurationHours("2-3 hours")).toBeCloseTo(2.5);
  });

  it("should convert a minutes-only value to hours", () => {
    expect(parseEstimatedDurationHours("90 minutes")).toBeCloseTo(1.5);
  });

  it("should return undefined for blank input", () => {
    expect(parseEstimatedDurationHours("  ")).toBeUndefined();
  });

  it("should return undefined when no unit can be inferred", () => {
    expect(parseEstimatedDurationHours("42")).toBeUndefined();
  });

  it("should return undefined when there are no numbers at all", () => {
    expect(parseEstimatedDurationHours("unknown")).toBeUndefined();
  });

  it("should not backtrack catastrophically on a long non-matching digit run", () => {
    // Regression guard for js/polynomial-redos: before bounding the numeric
    // groups this input (a huge digit run with a non-matching tail) drove the
    // hour+minute regex into O(n^2) backtracking. The test completing quickly
    // is the proof; the value is still `undefined` (no h/m unit present).
    expect(parseEstimatedDurationHours(`${"9".repeat(50_000)} x`)).toBeUndefined();
  });
});

describe("formatUsd", () => {
  it("should format sub-dollar amounts with 4 decimal places", () => {
    expect(formatUsd(0.00078)).toBe("$0.0008");
  });

  it("should format dollar-or-more amounts with 2 decimal places", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("should return 'unknown' for undefined", () => {
    expect(formatUsd(undefined)).toBe("unknown");
  });
});
