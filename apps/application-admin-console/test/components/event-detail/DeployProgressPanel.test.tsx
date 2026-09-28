import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeployProgressPanel } from "../../../src/components/event-detail/DeployProgressPanel";
import en from "../../../src/i18n/locales/en.json";

function realT(dict: Record<string, unknown>) {
  return (key: string, params?: Readonly<Record<string, string | number>>) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        dict,
      );
    let s = typeof value === "string" ? value : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

const t = realT(en);

const props = (over: Partial<Parameters<typeof DeployProgressPanel>[0]> = {}) => ({
  allDoneCount: 2,
  completeCount: 2,
  ended: false,
  failedCount: 0,
  inFlightCount: 0,
  manualRefreshInFlight: false,
  onManualRefresh: vi.fn(),
  t,
  totalDeployCount: 2,
  ...over,
});

describe("DeployProgressPanel", () => {
  it("should render nothing when there are no deployments yet", () => {
    const { container } = render(<DeployProgressPanel {...props({ totalDeployCount: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should show the in-flight state regardless of ended, and wire manual refresh", () => {
    const onManualRefresh = vi.fn();
    render(
      <DeployProgressPanel
        {...props({ allDoneCount: 1, inFlightCount: 1, totalDeployCount: 2, onManualRefresh })}
      />,
    );
    expect(screen.getByText("Deploying… (1 / 2)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Deploy is run asynchronously by the State Machine. It takes several minutes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("auto polling")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("deploy-status-reload"));
    expect(onManualRefresh).toHaveBeenCalled();
  });

  it("should keep the error indicator while a failure coexists with in-flight deploys", () => {
    const { container } = render(
      <DeployProgressPanel
        {...props({ allDoneCount: 1, failedCount: 1, inFlightCount: 1, totalDeployCount: 3 })}
      />,
    );
    expect(screen.getByText("Deploying… (1 / 3)")).toBeInTheDocument();
    const indicator = createWrapper(container).findStatusIndicator()?.getElement();
    expect(indicator?.outerHTML).toMatch(/status-error/);
    expect(indicator?.outerHTML).not.toMatch(/status-in-progress/);
  });

  it("should show the pre-event failed-deploy copy (retry individually) when not ended", () => {
    render(<DeployProgressPanel {...props({ failedCount: 1, ended: false })} />);
    expect(screen.getByText("Complete (with 1 failed)")).toBeInTheDocument();
    expect(
      screen.getByText(
        'Failed deployments can be retried individually with the "Retry failed" button.',
      ),
    ).toBeInTheDocument();
  });

  it("should show the ended failed-deploy copy once the event is terminal, not the retry hint", () => {
    render(<DeployProgressPanel {...props({ failedCount: 1, ended: true })} />);
    expect(
      screen.getByText("The event has ended. 1 deployment(s) never completed."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/retried individually/)).not.toBeInTheDocument();
  });

  it("should show 'ready to start' copy for a fully-deployed event that has not ended", () => {
    render(<DeployProgressPanel {...props({ ended: false })} />);
    expect(screen.getByText("Deploy complete")).toBeInTheDocument();
    expect(
      screen.getByText("All deploys completed. Ready to start the competition."),
    ).toBeInTheDocument();
  });

  it("should not claim the event is ready to start once it has ended", () => {
    render(<DeployProgressPanel {...props({ ended: true })} />);
    expect(screen.getByText("Deploy complete")).toBeInTheDocument();
    expect(screen.getByText("The event has ended.")).toBeInTheDocument();
    expect(screen.queryByText(/Ready to start the competition/)).not.toBeInTheDocument();
  });

  it("should show the failed variant of the header description", () => {
    render(
      <DeployProgressPanel {...props({ completeCount: 1, failedCount: 1, totalDeployCount: 2 })} />,
    );
    expect(screen.getByText("Complete 1 / In-flight 0 / Failed 1 of 2")).toBeInTheDocument();
  });

  it("should show the non-failed variant of the header description", () => {
    render(<DeployProgressPanel {...props({ completeCount: 2, totalDeployCount: 2 })} />);
    expect(screen.getByText("Complete 2 / In-flight 0 of 2")).toBeInTheDocument();
  });
});
