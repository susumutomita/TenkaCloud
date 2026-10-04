import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventDetail, EventStatus } from "../../../src/api/events-client";
import type { AppConfig } from "../../../src/config";
import { OverviewTab } from "../../../src/pages/event-detail/OverviewTab";
import type {
  EventOperations,
  EventTabContentProps,
} from "../../../src/pages/event-detail/tab-content-props";

vi.mock("../../../src/components/event-detail/ScoringLockPanel", () => ({
  ScoringLockPanel: () => <div data-testid="scoring-lock-panel-stub" />,
}));

const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    status: "READY" as EventStatus,
    problems: [{ problemId: "p1" }],
    teams: [{ internalSlug: "t1" }, { internalSlug: "t2" }],
    deploymentsByProblem: {},
    ...over,
  }) as unknown as EventDetail;

const props = (over: Partial<EventTabContentProps> = {}): EventTabContentProps => ({
  apiClient: null,
  canMutateTenant: true,
  config: {} as unknown as AppConfig,
  counts: {
    allDoneCount: 2,
    completeCount: 2,
    failedCount: 0,
    inFlightCount: 0,
    totalDeployCount: 2,
  },
  detail: detail(),
  manualRefresh: vi.fn(),
  manualRefreshInFlight: false,
  operations: {} as unknown as EventOperations,
  t: (key: string, params?: Record<string, string | number>) => {
    if (!params) return key;
    return `${key} ${JSON.stringify(params)}`;
  },
  wizard: { step: "in_competition", stepIndex: 3, primary: null },
  ...over,
});

describe("OverviewTab deploy-progress ended wiring", () => {
  it("should not claim the event is ready to start once its reserved end time has passed, even though status is still READY", () => {
    render(
      <OverviewTab
        {...props({
          detail: detail({ startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-02T00:00:00Z" }),
        })}
      />,
    );
    expect(
      screen.getByText("event_detail.deploy_progress_complete_description_ended"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("event_detail.deploy_progress_complete_description"),
    ).not.toBeInTheDocument();
  });

  it("should still claim the event is ready to start for a READY event before its end time", () => {
    render(
      <OverviewTab
        {...props({
          detail: detail({ startsAt: "2026-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z" }),
        })}
      />,
    );
    expect(
      screen.getByText("event_detail.deploy_progress_complete_description"),
    ).toBeInTheDocument();
  });

  it("should use the ended copy for an explicitly ENDED event too", () => {
    render(<OverviewTab {...props({ detail: detail({ status: "ENDED" }) })} />);
    expect(
      screen.getByText("event_detail.deploy_progress_complete_description_ended"),
    ).toBeInTheDocument();
  });
});

describe("OverviewTab local preparation wiring", () => {
  it("shows stopped local environments as prepared without changing cloud counts", () => {
    render(
      <OverviewTab
        {...props({
          config: { ...props().config, mode: "local-host" },
          detail: detail({
            teams: [{ teamId: "t1", internalSlug: "team-1" }],
            problems: [{ problemId: "p1", defaultRegion: "local" }],
            deploymentsByProblem: { p1: [{ jobId: "j1", teamId: "t1", status: "STOPPED" }] },
          }),
        })}
      />,
    );
    expect(screen.getByText(/local_host.progress_ready /)).toBeInTheDocument();
    expect(
      screen.getByText(
        'local_host.progress_counts {"prepared":1,"total":1,"running":0,"stopped":1}',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("event_detail.deploy_progress_complete")).not.toBeInTheDocument();
  });
});
