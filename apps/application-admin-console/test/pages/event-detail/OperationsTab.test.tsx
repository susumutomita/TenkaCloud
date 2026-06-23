import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail, EventStatus } from "../../../src/api/events-client";
import { OperationsTab } from "../../../src/pages/event-detail/OperationsTab";
import type {
  EventOperations,
  EventTabContentProps,
} from "../../../src/pages/event-detail/tab-content-props";

/**
 * Operations (= 高度操作) tab。 deploy / teardown のライフサイクル操作は「スケジュール」tab に集約
 * したので、 ここに残るのは復旧 (rescue) と deploy 進捗の確認だけ。 status を問わず内容を持つこと
 * (issue #1328 の「非 TEARDOWN で空 tab」回帰防止)、 force-archive の confirm 起動、 deploy 進捗
 * panel vs empty hint を pin する。 deploy / teardown の button はこの tab に存在しないことも確認。
 * 子 panel は stub、 props は fixture。
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
    canMutateTenant: true,
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

afterEach(() => vi.clearAllMocks());

describe("OperationsTab", () => {
  it("should render the rescue + deploy-progress sections with the empty hint by default", () => {
    renderTab();
    expect(screen.getByTestId("operations-tab-intro")).toBeInTheDocument();
    expect(screen.getByTestId("rescue-force-archive")).toBeInTheDocument();
    expect(screen.getByText("event_detail.operations_deploy_progress_empty")).toBeInTheDocument();
  });

  it("should not render deploy / teardown buttons (moved to the Schedule tab)", () => {
    renderTab();
    expect(screen.queryByTestId("operations-bulk-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("operations-bulk-deploy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("operations-delete-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("operations-delete-button")).not.toBeInTheDocument();
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
