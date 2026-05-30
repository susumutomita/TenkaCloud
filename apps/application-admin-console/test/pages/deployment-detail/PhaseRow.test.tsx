import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeploymentSummary, StackProgress } from "../../../src/api/deploy-client";
import type { DeployPhase } from "../../../src/lib/deploy-phases";
import { PhaseRow } from "../../../src/pages/deployment-detail/PhaseRow";

const t = (k: string) => k;
const deployment = {
  createdAt: "2026-06-01T00:00:00Z",
  tenantId: "tenant-1",
  problemId: "hello-world",
  displayTeamName: "Alpha",
  teamName: "team-alpha",
} as unknown as DeploymentSummary;
const buildingPhase: DeployPhase = { id: "building", name: "Building", status: "in-progress" };

const renderPhase = (stackProgress: StackProgress | null) => {
  const { container } = render(
    <PhaseRow
      phase={buildingPhase}
      deployment={deployment}
      stackProgress={stackProgress}
      stackProgressError={null}
      stackProgressPending={false}
      t={t}
    />,
  );
  // ExpandableSection を開いて body (= building case) を描画させる。
  createWrapper(container).findExpandableSection()?.findExpandButton()?.click();
  return container;
};

/**
 * PhaseRow の building phase body: console URL があれば Link、 無ければ「準備中」Box。
 */
describe("PhaseRow building phase", () => {
  it("should render the console link when a console URL is present", () => {
    const container = renderPhase({ consoleUrl: "https://console.aws.example/x" } as StackProgress);
    const link = container.querySelector('a[href="https://console.aws.example/x"]');
    expect(link).not.toBeNull();
  });

  it("should render the url-unavailable note when no console URL is present", () => {
    const container = renderPhase(null);
    expect(container.textContent).toContain("deployment_detail.phase_building_url_unavailable");
  });
});
