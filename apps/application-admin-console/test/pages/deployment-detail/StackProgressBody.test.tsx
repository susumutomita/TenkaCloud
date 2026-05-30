import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StackProgress } from "../../../src/api/deploy-client";
import { StackProgressBody } from "../../../src/pages/deployment-detail/StackProgressBody";
import type { StackProgressErrorState } from "../../../src/pages/deployment-detail/types";

/**
 * #534: StackProgressBody (CFn 進行状況 body)。 loading / error(notYetCreated・general) /
 * null / progress 描画 (console link + stackStatus 有無 + firstFailure(+reason 有無) + stuck
 * (isStuck / resourceLogicalId・resourceStatus 有無) + events/resources の rows・empty) を
 * pin する。 statusToIndicator は実物、 t は echo。
 */
const t = (k: string) => k;
const evt = (over: Record<string, unknown> = {}) =>
  ({
    timestamp: "2026-06-01T00:00:00Z",
    logicalResourceId: "MyBucket",
    resourceType: "AWS::S3::Bucket",
    resourceStatus: "CREATE_COMPLETE",
    ...over,
  }) as never;
const res = (over: Record<string, unknown> = {}) =>
  ({
    logicalResourceId: "MyBucket",
    resourceType: "AWS::S3::Bucket",
    resourceStatus: "CREATE_COMPLETE",
    ...over,
  }) as never;
const progress = (over: Partial<StackProgress> = {}): StackProgress =>
  ({
    consoleUrl: "https://console.aws/cfn",
    stackStatus: "CREATE_COMPLETE",
    events: [],
    resources: [],
    ...over,
  }) as unknown as StackProgress;
const renderBody = (
  p: StackProgress | null,
  error: StackProgressErrorState | null = null,
  pending = false,
) => render(<StackProgressBody progress={p} error={error} pending={pending} t={t} />);

describe("StackProgressBody", () => {
  it("should show a spinner while loading (no progress, no error, pending)", () => {
    renderBody(null, null, true);
    expect(screen.getByText("deployment_detail.stack_loading")).toBeInTheDocument();
  });

  it("should show the not-yet-created hint for that error state", () => {
    renderBody(null, { notYetCreated: true } as StackProgressErrorState);
    expect(screen.getByText("deployment_detail.stack_not_yet_created")).toBeInTheDocument();
  });

  it("should show a warning alert for a general fetch error", () => {
    renderBody(null, { notYetCreated: false, message: "fetch boom" } as StackProgressErrorState);
    expect(screen.getByText("fetch boom")).toBeInTheDocument();
  });

  it("should render nothing when there is no progress, error, or pending", () => {
    const { container } = renderBody(null, null, false);
    expect(container).toBeEmptyDOMElement();
  });

  it("should render console link, failure alert (+reason), stuck alert, and populated tables", () => {
    renderBody(
      progress({
        stackStatus: "ROLLBACK_IN_PROGRESS",
        events: [
          evt({
            logicalResourceId: "BadFn",
            resourceType: "AWS::Lambda::Function",
            resourceStatus: "CREATE_FAILED",
            resourceStatusReason: "quota exceeded",
          }),
        ],
        resources: [res({ physicalResourceId: "arn:phys" })],
        stuck: {
          isStuck: true,
          elapsedMinutes: 12,
          resourceLogicalId: "BadFn",
          resourceStatus: "CREATE_IN_PROGRESS",
          reason: "no progress",
          remediationHint: "check quota",
        } as never,
      }),
    );
    expect(screen.getByText("deployment_detail.open_cfn_console")).toBeInTheDocument();
    expect(screen.getByText("ROLLBACK_IN_PROGRESS")).toBeInTheDocument();
    // failure reason は alert + events table の reason 列の両方に出る。
    expect(screen.getAllByText("quota exceeded").length).toBeGreaterThan(0);
    expect(screen.getByText("no progress")).toBeInTheDocument(); // stuck reason
    expect(screen.getByText("arn:phys")).toBeInTheDocument(); // resource physical id
  });

  it("should handle missing optional fields (no stackStatus / no reason / stuck without target / empty tables)", () => {
    const { container } = renderBody(
      progress({
        stackStatus: undefined,
        events: [evt({ resourceStatus: "CREATE_FAILED" })], // _FAILED だが reason 無し
        resources: [res({ physicalResourceId: undefined })],
        stuck: {
          isStuck: true,
          elapsedMinutes: 3,
          reason: "stalled",
          remediationHint: "wait",
        } as never,
      }),
    );
    // stackStatus 無し → label 非表示 / failure reason 無し / stuck target 無し でも描画される。
    expect(screen.queryByText("deployment_detail.stack_status_label")).not.toBeInTheDocument();
    expect(screen.getByText("stalled")).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
  });

  it("should render a stuck target that has no resource status (the ?: null branch)", () => {
    renderBody(
      progress({
        stuck: {
          isStuck: true,
          elapsedMinutes: 5,
          resourceLogicalId: "StuckRes",
          reason: "r",
          remediationHint: "h",
        } as never,
      }),
    );
    expect(screen.getByText("StuckRes")).toBeInTheDocument();
  });

  it("should render empty-state hints when there are no events or resources and not stuck", () => {
    renderBody(progress({ events: [], resources: [], stuck: { isStuck: false } as never }));
    expect(screen.getByText("deployment_detail.events_empty")).toBeInTheDocument();
    expect(screen.getByText("deployment_detail.resources_empty")).toBeInTheDocument();
  });
});
