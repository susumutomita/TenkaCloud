import { describe, expect, it } from "vitest";
import {
  alwaysOnTypesUsed,
  type CostCatalogEntry,
  renderCostCatalog,
  resourceTypesUsed,
} from "../../../scripts/lib/cost-catalog";
import { analyzeProblemCost } from "../../../scripts/lib/problem-cost";

const TEMPLATE = `Resources:
  Table:
    Type: AWS::DynamoDB::Table
  Fn:
    Type: AWS::Lambda::Function
  Nat:
    Type: AWS::EC2::NatGateway
`;

const LAMBDA_ONLY = `Resources:
  Fn:
    Type: AWS::Lambda::Function
`;

function entry(over: Partial<CostCatalogEntry> = {}): CostCatalogEntry {
  return {
    id: "demo",
    name: "Demo Problem",
    category: "Challenge",
    estimatedDuration: "30 分",
    estimate: analyzeProblemCost(TEMPLATE, "30 分"),
    ...over,
  };
}

describe("cost catalog renderer (#1910 Slice 5)", () => {
  it("should list distinct AWS resource types without the AWS:: prefix, sorted", () => {
    expect(resourceTypesUsed(analyzeProblemCost(TEMPLATE, "30 分"))).toEqual([
      "DynamoDB::Table",
      "EC2::NatGateway",
      "Lambda::Function",
    ]);
  });

  it("should list only always-on resource types that carry standing cost", () => {
    expect(alwaysOnTypesUsed(analyzeProblemCost(TEMPLATE, "30 分"))).toEqual([
      "DynamoDB::Table",
      "EC2::NatGateway",
    ]);
  });

  it("should render a deterministic markdown table sorted by id", () => {
    const md = renderCostCatalog([entry({ id: "bbb" }), entry({ id: "aaa" })]);
    expect(md.startsWith("# Problem cost catalog")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    expect(md).toContain("| Problem | Category |");
    expect(md.indexOf("(`aaa`)")).toBeLessThan(md.indexOf("(`bbb`)"));
    expect(md).toContain("This catalog covers 2 problem(s); 2 contain always-on");
    expect(md).toContain("EC2::NatGateway");
  });

  it("should show an em dash for a problem with no standing-cost resources", () => {
    const md = renderCostCatalog([
      entry({ id: "lambda", estimate: analyzeProblemCost(LAMBDA_ONLY, "30 分") }),
    ]);
    expect(md).toContain("| — |");
    expect(md).toContain("This catalog covers 1 problem(s); 0 contain always-on");
  });

  it("should escape pipe characters in problem names", () => {
    const md = renderCostCatalog([entry({ name: "a | b" })]);
    expect(md).toContain("a \\| b");
  });

  it("should escape backslashes before pipes (complete escaping)", () => {
    const md = renderCostCatalog([entry({ name: "a\\b|c" })]);
    // backslash -> \\ first, then | -> \| : "a\\b\|c"
    expect(md).toContain("a\\\\b\\|c");
  });

  it("should render unknown when the session duration cannot be parsed", () => {
    const md = renderCostCatalog([
      entry({ estimatedDuration: "workshop", estimate: analyzeProblemCost(TEMPLATE, "workshop") }),
    ]);
    expect(md).toContain("unknown");
  });
});
