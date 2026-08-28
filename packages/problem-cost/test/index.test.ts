import { describe, expect, it } from "vitest";
import { analyzeProblemCost } from "../src/index";

const cfnTemplate = (resources: string) => `
Resources:
${resources}
`;

describe("analyzeProblemCost", () => {
  it("classifies a known standing resource without embedding a dollar price", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Table:
    Type: AWS::DynamoDB::Table
    Properties: {}
`),
    );
    expect(estimate.resources[0]).toMatchObject({
      logicalId: "Table",
      resourceType: "AWS::DynamoDB::Table",
      alwaysOn: true,
      riskLevel: "low",
    });
    expect(estimate.alwaysOnWarnings.map((resource) => resource.logicalId)).toEqual(["Table"]);
    expect(estimate.resources[0]).not.toHaveProperty("roughHourlyUsd");
    expect(estimate).not.toHaveProperty("totalHourlyUsd");
  });

  it("does not warn for a resource that has no independent standing charge", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Vpc:
    Type: AWS::EC2::VPC
    Properties: {}
`),
    );
    expect(estimate.alwaysOnWarnings).toEqual([]);
  });

  it("raises large EC2 instance families to high risk without assigning a rate", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Server:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: m5.xlarge
`),
    );
    expect(estimate.resources[0]).toMatchObject({ riskLevel: "high" });
    expect(estimate.resources[0]?.notes).toContain("InstanceType=m5.xlarge");
  });

  it("requires current-price verification for a dynamic EC2 instance type", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Server:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref InstanceTypeParam
`),
    );
    expect(
      estimate.resources[0]?.notes.some((note) => note.includes("current regional price")),
    ).toBe(true);
  });

  it("marks an unknown resource type for manual review", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Mystery:
    Type: AWS::Made::UpType
    Properties: {}
`),
    );
    expect(estimate.resources[0]?.riskLevel).toBe("unknown");
    expect(estimate.unclassifiedResourceTypes).toEqual(["AWS::Made::UpType"]);
  });

  it("treats Custom resources as invocation-time rather than standing resources", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Setup:
    Type: Custom::Bootstrap
    Properties: {}
`),
    );
    expect(estimate.resources[0]).toMatchObject({ alwaysOn: false, riskLevel: "low" });
    expect(estimate.unclassifiedResourceTypes).toEqual([]);
  });

  it("sorts resources by logical id", () => {
    const estimate = analyzeProblemCost(
      cfnTemplate(`
  Zebra:
    Type: AWS::EC2::NatGateway
    Properties: {}
  Alpha:
    Type: AWS::DynamoDB::Table
    Properties: {}
`),
    );
    expect(estimate.resources.map((resource) => resource.logicalId)).toEqual(["Alpha", "Zebra"]);
  });

  it("ignores malformed resource sections", () => {
    expect(analyzeProblemCost("Resources: not-an-object").resources).toEqual([]);
  });
});
