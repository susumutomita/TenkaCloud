import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "../../../src/api/deploy-client";
import { ProvenanceSummarySection } from "../../../src/pages/deployment-detail/ProvenanceSummarySection";

/**
 * [Problem Packs / Issue #2096] The organizer UI renders a compact
 * pack/version/digest summary for a PACK-SOURCED deployment, and HIDES the whole
 * provenance section for a core (non-pack) problem.
 */
const t = (k: string) => k;

const base: DeploymentSummary = {
  jobId: "01HJOB",
  problemId: "hello-world",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-hello-world-alpha",
  status: "COMPLETE",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:03.000Z",
  expiresAt: 1_800_000_000,
};

describe("ProvenanceSummarySection", () => {
  it("should hide the provenance section for a core problem", () => {
    const { container } = render(<ProvenanceSummarySection deployment={base} t={t} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should render the compact pack/version/digest summary for a pack deployment", () => {
    const deployment: DeploymentSummary = {
      ...base,
      provenance: {
        packId: "com.example.cloud-pack",
        packVersion: "1.2.0",
        contentDigest: "sha256-abc",
        catalogSnapshotId: "snap-123",
      },
    };
    render(<ProvenanceSummarySection deployment={deployment} t={t} />);

    expect(screen.getByText("deployment_detail.provenance_header")).toBeInTheDocument();
    expect(screen.getByText("com.example.cloud-pack")).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(screen.getByText("sha256-abc")).toBeInTheDocument();
    expect(screen.getByText("snap-123")).toBeInTheDocument();
  });
});
