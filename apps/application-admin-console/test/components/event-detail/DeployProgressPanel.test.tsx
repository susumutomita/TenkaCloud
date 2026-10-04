import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventDeploymentSummary, EventDetail } from "../../../src/api/events-client";
import { DeployProgressPanel } from "../../../src/components/event-detail/DeployProgressPanel";
import en from "../../../src/i18n/locales/en.json";
import ja from "../../../src/i18n/locales/ja.json";

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

function localDetail(over: Partial<EventDetail> = {}): EventDetail {
  return {
    eventId: "local-event",
    name: "Local event",
    status: "READY",
    teamCount: 1,
    problemCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    expiresAt: 0,
    teams: [{ teamId: "t1", internalSlug: "team-1" }],
    problems: ["p1", "p2", "p3"].map((problemId) => ({ problemId, defaultRegion: "local" })),
    deploymentsByProblem: Object.fromEntries(
      ["p1", "p2", "p3"].map((id) => [id, [{ jobId: id, teamId: "t1", status: "STOPPED" }]]),
    ),
    ...over,
  };
}

function withLocalJob(job: Partial<EventDeploymentSummary>): EventDetail {
  const detail = localDetail();
  return {
    ...detail,
    deploymentsByProblem: {
      ...detail.deploymentsByProblem,
      p1: [{ jobId: "p1", teamId: "t1", status: "STOPPED", ...job }],
    },
  };
}

describe("DeployProgressPanel local preparation", () => {
  it("counts three stopped on-demand environments as prepared and explains participant start", () => {
    const onManualRefresh = vi.fn();
    render(<DeployProgressPanel {...props({ localDetail: localDetail(), onManualRefresh })} />);
    expect(screen.getByText("Preparation complete")).toBeInTheDocument();
    expect(screen.getByText("Prepared 3 / 3 · Running 0 · Stopped 3")).toBeInTheDocument();
    expect(screen.getByText(en.local_host.progress_ready_hint)).toBeInTheDocument();
    expect(screen.queryByText(/State Machine/)).not.toBeInTheDocument();
    expect(screen.queryByText("auto polling")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("deploy-status-reload"));
    expect(onManualRefresh).toHaveBeenCalledOnce();
  });

  it("keeps prepared and running counts separate and updates after a participant starts", () => {
    const { rerender } = render(<DeployProgressPanel {...props({ localDetail: localDetail() })} />);
    rerender(
      <DeployProgressPanel {...props({ localDetail: withLocalJob({ status: "COMPLETE" }) })} />,
    );
    expect(screen.getByText("Prepared 3 / 3 · Running 1 · Stopped 2")).toBeInTheDocument();
    expect(screen.getByText("Preparation complete")).toBeInTheDocument();
  });

  it.each([
    ["PENDING", "Preparation in progress"],
    ["IN_PROGRESS", "Preparation in progress"],
    ["DELETING", "Preparation in progress"],
    ["FAILED", "Preparation needs attention (1 failed)"],
    ["EXPIRED", "Preparation needs attention (1 failed)"],
    ["DELETED", "Preparation incomplete"],
    ["AUTO_DELETED", "Preparation incomplete"],
  ] as const)(
    "does not report readiness for %s even if the event still says READY",
    (status, label) => {
      render(<DeployProgressPanel {...props({ localDetail: withLocalJob({ status }) })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("Prepared 2 / 3 · Running 0 · Stopped 2")).toBeInTheDocument();
      expect(screen.queryByText("Preparation complete")).not.toBeInTheDocument();
    },
  );

  it.each(["stop", "restart", "teardown"] as const)(
    "waits for an unfinished %s operation",
    (operation) => {
      render(<DeployProgressPanel {...props({ localDetail: withLocalJob({ operation }) })} />);
      expect(screen.getByText("Preparation in progress")).toBeInTheDocument();
      expect(screen.getByText("auto polling")).toBeInTheDocument();
      expect(screen.queryByText("Preparation complete")).not.toBeInTheDocument();
    },
  );

  it("shows an active retry while the job still has its previous FAILED status", () => {
    const retrying = withLocalJob({ status: "FAILED", operation: "restart" });
    const { rerender } = render(<DeployProgressPanel {...props({ localDetail: retrying })} />);
    expect(screen.getByText("Preparation in progress")).toBeInTheDocument();
    expect(screen.queryByText(/Preparation needs attention/)).not.toBeInTheDocument();
    expect(screen.getByText("auto polling")).toBeInTheDocument();

    const anotherFailure = {
      ...retrying,
      deploymentsByProblem: {
        ...retrying.deploymentsByProblem,
        p2: [{ jobId: "p2", teamId: "t1", status: "FAILED" as const }],
      },
    };
    rerender(<DeployProgressPanel {...props({ localDetail: anotherFailure })} />);
    expect(screen.getByText("Preparation needs attention (1 failed)")).toBeInTheDocument();
    expect(screen.getByText("auto polling")).toBeInTheDocument();
  });

  it("requires every expected team/problem environment, including missing rows", () => {
    const detail = localDetail();
    const incomplete = {
      ...detail,
      deploymentsByProblem: { ...detail.deploymentsByProblem, p1: [] },
    };
    render(<DeployProgressPanel {...props({ localDetail: incomplete })} />);
    expect(screen.getByText("Preparation incomplete")).toBeInTheDocument();
    expect(screen.getByText("Prepared 2 / 3 · Running 0 · Stopped 2")).toBeInTheDocument();
  });

  it("waits for the host to finish preparing the event", () => {
    render(
      <DeployProgressPanel {...props({ localDetail: localDetail({ status: "DEPLOYING" }) })} />,
    );
    expect(screen.getByText("Preparation in progress")).toBeInTheDocument();
    expect(screen.queryByText("Preparation complete")).not.toBeInTheDocument();
  });

  it("offers preparation from Schedule when there are no deployments", () => {
    render(
      <DeployProgressPanel
        {...props({
          totalDeployCount: 0,
          localDetail: localDetail({ status: "DRAFT", deploymentsByProblem: {} }),
        })}
      />,
    );
    expect(screen.getByText("Prepared 0 / 3 · Running 0 · Stopped 0")).toBeInTheDocument();
    expect(screen.getByText(en.local_host.progress_prepare_hint)).toBeInTheDocument();
  });

  it.each(["READY", "ENDED", "TEARDOWN", "ARCHIVED"] as const)(
    "does not invite participation after %s has effectively ended",
    (status) => {
      render(
        <DeployProgressPanel {...props({ ended: true, localDetail: localDetail({ status }) })} />,
      );
      expect(screen.getByText("Event ended")).toBeInTheDocument();
      expect(screen.queryByText("Preparation complete")).not.toBeInTheDocument();
      expect(screen.queryByText(en.local_host.progress_ready_hint)).not.toBeInTheDocument();
    },
  );

  it("does not ask an already scheduled or running event to start again", () => {
    render(
      <DeployProgressPanel
        {...props({ localDetail: localDetail({ startsAt: "2026-01-01T00:00:00Z" }) })}
      />,
    );
    expect(screen.getByText(en.local_host.progress_scheduled_hint)).toBeInTheDocument();
    expect(screen.queryByText(en.local_host.progress_ready_hint)).not.toBeInTheDocument();
  });

  it("shows short preparation and runtime labels in Japanese", () => {
    render(<DeployProgressPanel {...props({ localDetail: localDetail(), t: realT(ja) })} />);
    expect(screen.getByText("準備完了")).toBeInTheDocument();
    expect(screen.getByText("準備済み 3 / 3 件・稼働中 0・停止中 3")).toBeInTheDocument();
  });
});
