import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ProblemAlwaysOnSummary,
  ProblemCostSummary,
} from "../../src/components/ProblemCostSummary";
import type { ProblemCostEstimateSummary } from "../../src/data/problems";

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const estimate = (over: Partial<ProblemCostEstimateSummary> = {}): ProblemCostEstimateSummary => ({
  alwaysOnResources: [
    {
      logicalId: "Database",
      resourceType: "AWS::RDS::DBInstance",
      riskLevel: "high",
    },
  ],
  unclassifiedResourceTypes: [],
  resourceTypes: ["AWS::EC2::Instance", "AWS::RDS::DBInstance"],
  ...over,
});

describe("ProblemCostSummary", () => {
  it("should render qualitative cost risk and always-on resources", () => {
    render(<ProblemCostSummary estimate={estimate()} t={t} />);

    expect(screen.getByText(/problem_cost.always_on_count/)).toBeInTheDocument();
    expect(screen.getByText(/Database/)).toBeInTheDocument();
    expect(screen.getAllByText(/AWS::RDS::DBInstance/).length).toBeGreaterThan(0);
    expect(screen.getByText(/AWS::EC2::Instance, AWS::RDS::DBInstance/)).toBeInTheDocument();
  });

  it("should render a quiet state when no estimate is available", () => {
    render(<ProblemCostSummary estimate={undefined} t={t} />);

    expect(screen.getByText("problem_cost.unavailable")).toBeInTheDocument();
  });

  it("should render a quiet always-on state when no estimate is available", () => {
    render(<ProblemAlwaysOnSummary estimate={undefined} t={t} />);

    expect(screen.getByText("problem_cost.unavailable")).toBeInTheDocument();
  });

  it("should render no always-on and manual-review branches", () => {
    render(
      <ProblemCostSummary
        estimate={estimate({
          alwaysOnResources: [],
          unclassifiedResourceTypes: ["AWS::Unknown::Thing"],
        })}
        t={t}
      />,
    );

    expect(screen.getAllByText("problem_cost.no_always_on").length).toBeGreaterThan(0);
    expect(screen.getByText(/problem_cost.manual_review/)).toBeInTheDocument();
  });
});
