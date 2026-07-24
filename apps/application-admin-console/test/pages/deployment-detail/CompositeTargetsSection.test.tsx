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
    {
      // Recovered after a retry: still carries the prior reason, but is no
      // longer FAILED, so the cell must show the placeholder, not the reason.
      targetId: "recovered",
      targetDeploymentId: "01HTARGETrecovered",
      ordinal: 4,
      provider: "aws",
      engine: "cloudformation",
      status: "COMPLETE",
      updatedAt: "2026-06-29T00:00:07.000Z",
      failureReason: "transient throttling",
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

    // A recovered target that still carries a stale reason must not surface it.
    const recovered = within(targetRow("recovered"));
    expect(recovered.queryByText("transient throttling")).toBeNull();
    expect(
      recovered.getByText("deployment_detail.composite_failure_reason_none"),
    ).toBeInTheDocument();
  });

  it("should render an empty-state message when a composite parent has no targets", () => {
    render(<CompositeTargetsSection composite={{ version: 1, targets: [] }} t={t} />);
    expect(screen.getByText("deployment_detail.composite_targets_empty")).toBeInTheDocument();
  });

  /**
   * [Composite Runtime / Issue #2747] Every `dependencyState` StatusIndicator variant, the
   * legacy (no dataflow metadata) branch, and the `dependsOn` / `inputParameters` "some entries"
   * vs. "none" branches — all `hasDataflowMetadata` paths in `composite-detail.ts` projected here.
   */
  describe("Composite dataflow metadata (#2747)", () => {
    const dataflowComposite: CompositeDetail = {
      version: 1,
      targets: [
        {
          targetId: "ready-target",
          targetDeploymentId: "01HTARGETready",
          ordinal: 0,
          provider: "gcp",
          engine: "infra-manager",
          status: "PENDING",
          updatedAt: "2026-07-22T00:00:00.000Z",
          dependencyState: "ready",
          dependsOn: [],
          inputParameters: [],
        },
        {
          targetId: "waiting-target",
          targetDeploymentId: "01HTARGETwaiting",
          ordinal: 1,
          provider: "aws",
          engine: "cloudformation",
          status: "PENDING",
          updatedAt: "2026-07-22T00:00:01.000Z",
          dependencyState: "waiting",
          dependsOn: ["ready-target"],
          inputParameters: ["GcpEndpoint"],
        },
        {
          targetId: "running-target",
          targetDeploymentId: "01HTARGETrunning",
          ordinal: 2,
          provider: "azure",
          engine: "bicep",
          status: "IN_PROGRESS",
          updatedAt: "2026-07-22T00:00:02.000Z",
          dependencyState: "running",
          dependsOn: ["ready-target", "waiting-target"],
          inputParameters: ["GcpEndpoint", "AwsEndpoint"],
        },
        {
          targetId: "complete-target",
          targetDeploymentId: "01HTARGETcomplete",
          ordinal: 3,
          provider: "sakura",
          engine: "apprun",
          status: "COMPLETE",
          updatedAt: "2026-07-22T00:00:03.000Z",
          dependencyState: "complete",
        },
        {
          targetId: "blocked-target",
          targetDeploymentId: "01HTARGETblocked",
          ordinal: 4,
          provider: "aws",
          engine: "cloudformation",
          status: "FAILED",
          updatedAt: "2026-07-22T00:00:04.000Z",
          dependencyState: "blocked",
          failureReason: "dependency blocked: ready-target",
        },
        {
          // A row that predates #2747 (no dependencyState / dependsOn / inputParameters at all).
          targetId: "legacy-target",
          targetDeploymentId: "01HTARGETlegacy",
          ordinal: 5,
          provider: "aws",
          engine: "cloudformation",
          status: "COMPLETE",
          updatedAt: "2026-07-22T00:00:05.000Z",
        },
      ],
    };

    it("should render the matching StatusIndicator label for every dependencyState", () => {
      render(<CompositeTargetsSection composite={dataflowComposite} t={t} />);

      for (const state of ["ready", "waiting", "running", "complete", "blocked"] as const) {
        const row = within(targetRow(`${state}-target`));
        expect(
          row.getByText(`deployment_detail.composite_dependency_${state}`),
        ).toBeInTheDocument();
      }
    });

    it("should render the legacy placeholder when dependencyState is absent", () => {
      render(<CompositeTargetsSection composite={dataflowComposite} t={t} />);

      const legacy = within(targetRow("legacy-target"));
      expect(legacy.getByText("deployment_detail.composite_dependency_legacy")).toBeInTheDocument();
    });

    it("should join dependsOn target ids, and fall back to common.none when empty or absent", () => {
      render(<CompositeTargetsSection composite={dataflowComposite} t={t} />);

      expect(within(targetRow("waiting-target")).getByText("ready-target")).toBeInTheDocument();
      expect(
        within(targetRow("running-target")).getByText("ready-target, waiting-target"),
      ).toBeInTheDocument();
      // Explicit empty array (independent target) — dependsOn and inputParameters both empty,
      // so the row has two "common.none" cells.
      expect(within(targetRow("ready-target")).getAllByText("common.none")).toHaveLength(2);
      // Absent entirely (legacy row) — dependencyState / dependsOn / inputParameters all absent.
      expect(within(targetRow("legacy-target")).getAllByText("common.none")).toHaveLength(2);
    });

    it("should join bound input parameter names, and fall back to common.none when empty or absent", () => {
      render(<CompositeTargetsSection composite={dataflowComposite} t={t} />);

      expect(within(targetRow("waiting-target")).getByText("GcpEndpoint")).toBeInTheDocument();
      expect(
        within(targetRow("running-target")).getByText("GcpEndpoint, AwsEndpoint"),
      ).toBeInTheDocument();
      // Explicit empty array (independent target — no bindings) — two "common.none" cells
      // (dependsOn and inputParameters both empty).
      expect(within(targetRow("ready-target")).getAllByText("common.none")).toHaveLength(2);
      // Absent entirely (complete-target has dependencyState but no dependsOn/inputParameters) —
      // also two "common.none" cells.
      expect(within(targetRow("complete-target")).getAllByText("common.none")).toHaveLength(2);
    });
  });
});
