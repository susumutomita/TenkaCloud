import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentSummary } from "../../../src/api/deploy-client";
import type { DeployPhase } from "../../../src/lib/deploy-phases";
import { DeployLogSection } from "../../../src/pages/deployment-detail/DeployLogSection";

/**
 * DeployLogSection: deploy log 区画 (scroll top/bottom / maximize button + PhaseRow 一覧)。
 * scroll button → scrollIntoView(top/bottom)、 maximize → onMaximize、 非 terminal status での
 * auto-refresh 説明文 vs terminal での非表示、 phases の PhaseRow 描画を pin する。
 * PhaseRow は stub、 scrollIntoView は jsdom 未実装なので spy で stub。
 */
vi.mock("../../../src/pages/deployment-detail/PhaseRow", () => ({
  PhaseRow: ({ phase }: { phase: DeployPhase }) => (
    <div data-testid="phase-row">{(phase as { id: string }).id}</div>
  ),
}));

const deployment = (status: string): DeploymentSummary =>
  ({ jobId: "job-1", status }) as unknown as DeploymentSummary;
const phases = [{ id: "validate" }, { id: "deploy" }] as unknown as DeployPhase[];

const props = (over: Partial<Parameters<typeof DeployLogSection>[0]> = {}) => ({
  deployment: deployment("IN_PROGRESS"),
  phases,
  stackProgress: null,
  stackProgressError: null,
  stackProgressPending: false,
  onMaximize: vi.fn(),
  t: (k: string) => k,
  ...over,
});

let scrollSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollSpy = vi.fn();
  // jsdom は scrollIntoView 未実装なので prototype に生やす。
  Element.prototype.scrollIntoView =
    scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
});
afterEach(() => vi.clearAllMocks());

describe("DeployLogSection", () => {
  it("should render a PhaseRow per phase and the auto-refresh hint for non-terminal status", () => {
    render(<DeployLogSection {...props()} />);
    expect(screen.getAllByTestId("phase-row")).toHaveLength(2);
    expect(screen.getByText(/deployment_detail\.log_auto_refresh/)).toBeInTheDocument();
  });

  it("should hide the auto-refresh hint for a terminal status", () => {
    render(<DeployLogSection {...props({ deployment: deployment("COMPLETE") })} />);
    expect(screen.queryByText(/deployment_detail\.log_auto_refresh/)).not.toBeInTheDocument();
  });

  it("should scroll to top and bottom from the scroll buttons", () => {
    render(<DeployLogSection {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "deployment_detail.log_scroll_top" }));
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: "deployment_detail.log_scroll_bottom" }));
    expect(scrollSpy).toHaveBeenCalledWith({ block: "end", behavior: "smooth" });
  });

  it("should invoke onMaximize from the maximize button", () => {
    const onMaximize = vi.fn();
    render(<DeployLogSection {...props({ onMaximize })} />);
    fireEvent.click(screen.getByTestId("maximize-log"));
    expect(onMaximize).toHaveBeenCalled();
  });
});
