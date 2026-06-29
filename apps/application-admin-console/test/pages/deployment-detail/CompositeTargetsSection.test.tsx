import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CompositeDetail } from "../../../src/api/deploy-client";
import { CompositeTargetsSection } from "../../../src/pages/deployment-detail/CompositeTargetsSection";

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const composite: CompositeDetail = {
  version: 1,
  targets: [
    {
      targetId: "edge",
      targetDeploymentId: "01HTARGETaws",
      ordinal: 0,
      provider: "aws",
      engine: "cloudformation",
      status: "COMPLETE",
      updatedAt: "2026-06-29T00:00:03.000Z",
    },
    {
      targetId: "compute",
      targetDeploymentId: "01HTARGETgcp",
      ordinal: 1,
      provider: "gcp",
      engine: "infra-manager",
      status: "IN_PROGRESS",
      updatedAt: "2026-06-29T00:00:04.000Z",
    },
    {
      targetId: "store",
      targetDeploymentId: "01HTARGETazure",
      ordinal: 2,
      provider: "azure",
      engine: "bicep",
      status: "FAILED",
      updatedAt: "2026-06-29T00:00:05.000Z",
      failureReason: "quota exceeded",
    },
    {
      targetId: "relay",
      targetDeploymentId: "01HTARGETsakura",
      ordinal: 3,
      provider: "sakura",
      engine: "apprun",
      status: "PENDING",
      updatedAt: "2026-06-29T00:00:06.000Z",
    },
  ],
};

describe("CompositeTargetsSection", () => {
  /** Resolve the `<tr>` that owns a target's identity cell. */
  function targetRow(targetId: string): HTMLElement {
    const cell = screen.getByTestId(`composite-target-${targetId}`);
    const row = cell.closest("tr");
    if (!row) throw new Error(`row for ${targetId} not found`);
    return row;
  }

  it("should render one row per composite target with id, provider, engine and status", () => {
    render(<CompositeTargetsSection composite={composite} t={t} />);

    expect(screen.getByText("deployment_detail.composite_targets_header")).toBeInTheDocument();

    for (const target of composite.targets) {
      const cells = within(targetRow(target.targetId));
      expect(cells.getByText(target.targetId)).toBeInTheDocument();
      expect(cells.getByText(target.provider)).toBeInTheDocument();
      expect(cells.getByText(target.engine)).toBeInTheDocument();
      expect(cells.getByText(target.status)).toBeInTheDocument();
    }
  });

  it("should render the failure reason only for a failed target", () => {
    render(<CompositeTargetsSection composite={composite} t={t} />);

    const failed = within(targetRow("store"));
    expect(failed.getByText("quota exceeded")).toBeInTheDocument();

    // A non-failed target shows the placeholder, never another target's reason.
    const complete = within(targetRow("edge"));
    expect(complete.queryByText("quota exceeded")).toBeNull();
  });

  it("should render an empty-state message when a composite parent has no targets", () => {
    render(<CompositeTargetsSection composite={{ version: 1, targets: [] }} t={t} />);
    expect(screen.getByText("deployment_detail.composite_targets_empty")).toBeInTheDocument();
  });
});
