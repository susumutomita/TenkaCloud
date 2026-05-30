import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "../../../src/api/deploy-client";
import { BasicInfoSection } from "../../../src/pages/deployment-detail/BasicInfoSection";

const t = (k: string) => k;
const base = {
  problemId: "hello-world",
  displayTeamName: "Alpha",
  teamName: "team-alpha",
  awsAccountId: "111111111111",
  region: "ap-northeast-1",
  namePrefix: "tc-hello",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T01:00:00Z",
};

/**
 * BasicInfoSection の stackId 有無 (assigned ↔ unassigned) と displayTeamName の fallback。
 */
describe("BasicInfoSection", () => {
  it("should show the stack id as code when it is assigned", () => {
    const item = { ...base, stackId: "arn:aws:cloudformation:stack/abc" } as DeploymentSummary;
    render(<BasicInfoSection item={item} t={t} />);
    expect(screen.getByText("arn:aws:cloudformation:stack/abc")).toBeInTheDocument();
  });

  it("should fall back to the unassigned label and unset team name when missing", () => {
    const item = { ...base, displayTeamName: undefined, stackId: undefined } as DeploymentSummary;
    render(<BasicInfoSection item={item} t={t} />);
    expect(screen.getByText("deployment_detail.value_unassigned")).toBeInTheDocument();
    expect(screen.getByText("deployment_detail.value_unset")).toBeInTheDocument();
  });
});
