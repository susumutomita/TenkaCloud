import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail, EventStatus } from "../../../src/api/events-client";
import { OperationsTab } from "../../../src/pages/event-detail/OperationsTab";
import type {
  EventOperations,
  EventTabContentProps,
} from "../../../src/pages/event-detail/tab-content-props";

/**
 * Issue #1318/#1328: Operations tab。 status 不問で常時 4 section (rescue / 一括操作 /
 * deploy 進捗 / 削除) を出す。 bulk deploy の disabled 条件 (問題0 / team0 / 終了系 status /
 * 実行中) / bulk teardown・delete の confirm 起動 / deploy 進捗 panel vs empty / loading 状態を
 * pin する。 子 panel は stub、 props は fixture。
 */
vi.mock("../../../src/components/event-detail/DeployProgressPanel", () => ({
  DeployProgressPanel: () => <div data-testid="deploy-progress-panel" />,
}));
vi.mock("../../../src/components/event-detail/EventWizardPanel", () => ({
  EventRescuePanel: ({ onForceArchive }: { onForceArchive: () => void }) => (
    <button type="button" data-testid="rescue-force-archive" onClick={onForceArchive}>
      rescue
    </button>
  ),
}));

const operations = (over: Partial<EventOperations> = {}): EventOperations =>
  ({
    bulkInFlight: null,
    forceArchiveInFlight: false,
    handleBulkDeploy: vi.fn(),
    setConfirmTeardown: vi.fn(),
    setConfirmForceArchive: vi.fn(),
    ...over,
  }) as unknown as EventOperations;

const detail = (status: EventStatus, problems = 1, teams = 1): EventDetail =>
  ({
    status,
    problems: Array.from({ length: problems }, (_, i) => ({ problemId: `p${i}` })),
    teams: Array.from({ length: teams }, (_, i) => ({ internalSlug: `t${i}` })),
  }) as unknown as EventDetail;

const props = (over: Partial<EventTabContentProps> = {}): EventTabContentProps =>
  ({
    apiClient: {} as never,
    config: {} as never,
    counts: {
      allDoneCount: 0,
      completeCount: 0,
      failedCount: 0,
      inFlightCount: 0,
      totalDeployCount: 0,
    },
    detail: detail("READY"),
    manualRefresh: vi.fn(),
    manualRefreshInFlight: false,
    operations: operations(),
    t: (k: string) => k,
    wizard: {} as never,
    ...over,
  }) as EventTabContentProps;

const renderTab = (over: Partial<EventTabContentProps> = {}) =>
  render(<OperationsTab {...props(over)} />);
const bulkDeployBtn = () => screen.getByTestId("operations-bulk-deploy");

afterEach(() => vi.clearAllMocks());

describe("OperationsTab", () => {
  it("should render all four sections with the empty deploy-progress hint by default", () => {
    renderTab();
    expect(screen.getByTestId("operations-tab-intro")).toBeInTheDocument();
    expect(screen.getByTestId("rescue-force-archive")).toBeInTheDocument();
    expect(screen.getByTestId("operations-bulk-section")).toBeInTheDocument();
    expect(screen.getByText("event_detail.operations_deploy_progress_empty")).toBeInTheDocument();
    expect(screen.getByTestId("operations-delete-section")).toBeInTheDocument();
  });

  it("should enable bulk deploy and trigger it on a READY event with problems and teams", () => {
    const ops = operations();
    renderTab({ operations: ops });
    expect(bulkDeployBtn()).not.toBeDisabled();
    fireEvent.click(bulkDeployBtn());
    expect(ops.handleBulkDeploy).toHaveBeenCalled();
  });

  it("should disable bulk deploy when there are no problems or no teams", () => {
    renderTab({ detail: detail("READY", 0, 1) });
    expect(bulkDeployBtn()).toBeDisabled();
    renderTab({ detail: detail("READY", 1, 0) });
    expect(
      screen
        .getAllByTestId("operations-bulk-deploy")
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it.each<EventStatus>([
    "ENDED",
    "TEARDOWN",
    "ARCHIVED",
  ])("should disable bulk deploy for terminal status %s", (status) => {
    renderTab({ detail: detail(status) });
    expect(bulkDeployBtn()).toBeDisabled();
  });

  it("should disable bulk actions and show loading while a bulk op is in flight", () => {
    renderTab({ operations: operations({ bulkInFlight: "deploy" }) });
    expect(bulkDeployBtn()).toBeDisabled();
    expect(screen.getByTestId("operations-bulk-teardown")).toBeDisabled();
  });

  it("should open the teardown confirmation from bulk teardown and delete buttons", () => {
    const ops = operations();
    renderTab({ operations: ops });
    fireEvent.click(screen.getByTestId("operations-bulk-teardown"));
    fireEvent.click(screen.getByTestId("operations-delete-button"));
    expect(ops.setConfirmTeardown).toHaveBeenCalledTimes(2);
    expect(ops.setConfirmTeardown).toHaveBeenCalledWith(true);
  });

  it("should open the force-archive confirmation from the rescue panel", () => {
    const ops = operations();
    renderTab({ operations: ops });
    fireEvent.click(screen.getByTestId("rescue-force-archive"));
    expect(ops.setConfirmForceArchive).toHaveBeenCalledWith(true);
  });

  it("should render the deploy-progress panel when there are deployments", () => {
    renderTab({
      counts: {
        allDoneCount: 1,
        completeCount: 1,
        failedCount: 0,
        inFlightCount: 0,
        totalDeployCount: 2,
      },
    });
    expect(screen.getByTestId("deploy-progress-panel")).toBeInTheDocument();
    expect(
      screen.queryByText("event_detail.operations_deploy_progress_empty"),
    ).not.toBeInTheDocument();
  });
});
