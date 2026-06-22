import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail, EventStatus } from "../../../src/api/events-client";
import { EventHeaderActions } from "../../../src/components/event-detail/EventHeaderActions";
import type { WizardState } from "../../../src/lib/event-wizard";

/**
 * EventHeaderActions: Event Detail header の操作 button 群。 back / deploy / retry-failed /
 * redeploy / end / scoring lock-unlock / print-report の表示条件・callback・disabled
 * (detail 不在 / 問題0 / team0 / 終了系 status / bulkInFlight / status!==READY / apiClient 不在) /
 * scoringLocked による lock-unlock 切替 / wizard primary による variant を pin する。
 * 破壊的な teardown は header に置かず「高度操作」tab の danger zone に集約したので header には無い。
 * useNavigate / isReportReady を mock。
 */
const { mockNav, mockIsReportReady } = vi.hoisted(() => ({
  mockNav: vi.fn(),
  mockIsReportReady: vi.fn(),
}));
vi.mock("react-router", () => ({ useNavigate: () => mockNav }));
vi.mock("../../../src/lib/event-report-stats", () => ({ isReportReady: mockIsReportReady }));

type Props = Parameters<typeof EventHeaderActions>[0];
const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    eventId: "e1",
    status: "READY",
    problems: [{ problemId: "p" }],
    teams: [{ internalSlug: "t" }],
    scoringLocked: false,
    ...over,
  }) as unknown as EventDetail;
const props = (over: Partial<Props> = {}): Props => ({
  apiClient: {} as never,
  bulkInFlight: null,
  canMutateTenant: true,
  completeCount: 0,
  detail: detail(),
  endInFlight: false,
  failedCount: 0,
  onBack: vi.fn(),
  onBulkDeploy: vi.fn(),
  onEnd: vi.fn(),
  onLockScoring: vi.fn(),
  onUnlockScoring: vi.fn(),
  scoringLockInFlight: null,
  t: (k: string) => k,
  wizard: null,
  ...over,
});
const renderActions = (over: Partial<Props> = {}) =>
  render(<EventHeaderActions {...props(over)} />);
const btn = (name: string) => screen.getByRole("button", { name });
const queryBtn = (name: string) => screen.queryByRole("button", { name });

afterEach(() => {
  vi.clearAllMocks();
  mockIsReportReady.mockReturnValue(false);
});

describe("EventHeaderActions", () => {
  it("should render only the base buttons (disabled) when detail is null", () => {
    renderActions({ detail: null });
    fireEvent.click(btn("event_detail.back_to_list"));
    expect(btn("event_detail.deploy_button")).toBeDisabled();
    expect(btn("event_detail.end_event")).toBeDisabled();
    // teardown は header から撤去 (= 高度操作 tab の danger zone のみ)。
    expect(queryBtn("event_detail.delete_button")).not.toBeInTheDocument();
    expect(queryBtn("event_detail.scoring_lock")).not.toBeInTheDocument();
  });

  it("should fire every action on a fully-actionable READY event with failed + complete deploys", () => {
    mockIsReportReady.mockReturnValue(true);
    const p = props({
      detail: detail({ status: "READY", scoringLocked: false }),
      failedCount: 2,
      completeCount: 3,
      wizard: { primary: "deploy" } as unknown as WizardState,
    });
    render(<EventHeaderActions {...p} />);
    fireEvent.click(btn("event_detail.back_to_list"));
    expect(p.onBack).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.deploy_button"));
    expect(p.onBulkDeploy).toHaveBeenCalledWith();
    fireEvent.click(btn("event_detail.retry_failed"));
    expect(p.onBulkDeploy).toHaveBeenCalledWith({ retryFailedOnly: true });
    fireEvent.click(btn("event_detail.redeploy"));
    // redeploy is destructive → it opens a confirm modal instead of firing immediately
    expect(p.onBulkDeploy).not.toHaveBeenCalledWith({ forceRedeploy: true });
    fireEvent.click(btn("event_detail.modal_redeploy_confirm"));
    expect(p.onBulkDeploy).toHaveBeenCalledWith({ forceRedeploy: true });
    fireEvent.click(btn("event_detail.end_event"));
    expect(p.onEnd).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.scoring_lock"));
    expect(p.onLockScoring).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.print_report"));
    expect(mockNav).toHaveBeenCalledWith("/events/e1/report");
  });

  it("should cancel the redeploy confirm modal without deploying", () => {
    const p = props({ detail: detail({ status: "READY" }), completeCount: 2 });
    render(<EventHeaderActions {...p} />);
    fireEvent.click(btn("event_detail.redeploy"));
    fireEvent.click(btn("event_detail.modal_cancel"));
    expect(p.onBulkDeploy).not.toHaveBeenCalled();
  });

  it("should show unlock when scoring is locked and route to onUnlockScoring", () => {
    const p = props({ detail: detail({ status: "ENDED", scoringLocked: true }) });
    render(<EventHeaderActions {...p} />);
    fireEvent.click(btn("event_detail.scoring_unlock"));
    expect(p.onUnlockScoring).toHaveBeenCalled();
    // ENDED → deploy / end disabled。
    expect(btn("event_detail.deploy_button")).toBeDisabled();
    expect(btn("event_detail.end_event")).toBeDisabled();
  });

  it.each<EventStatus>([
    "ENDED",
    "TEARDOWN",
    "ARCHIVED",
  ])("should disable bulk actions for terminal status %s", (status) => {
    renderActions({ detail: detail({ status }), failedCount: 1, completeCount: 1 });
    expect(btn("event_detail.deploy_button")).toBeDisabled();
    expect(btn("event_detail.retry_failed")).toBeDisabled();
    expect(btn("event_detail.redeploy")).toBeDisabled();
  });

  it("should hide conditional buttons when there is nothing to act on", () => {
    renderActions({ detail: detail({ status: "DRAFT" }), failedCount: 0, completeCount: 0 });
    expect(queryBtn("event_detail.retry_failed")).not.toBeInTheDocument();
    expect(queryBtn("event_detail.redeploy")).not.toBeInTheDocument();
    expect(queryBtn("event_detail.scoring_lock")).not.toBeInTheDocument(); // DRAFT は scoring 非表示
    expect(queryBtn("event_detail.print_report")).not.toBeInTheDocument(); // isReportReady=false
  });

  it("should disable deploy when the event has no problems or no teams", () => {
    renderActions({ detail: detail({ problems: [] }) });
    expect(btn("event_detail.deploy_button")).toBeDisabled();
    renderActions({ detail: detail({ teams: [] }) });
    expect(
      screen
        .getAllByRole("button", { name: "event_detail.deploy_button" })
        .some((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("should not render a teardown/delete button in the header (moved to the advanced tab danger zone)", () => {
    renderActions({ detail: detail({ status: "READY" }) });
    expect(queryBtn("event_detail.delete_button")).not.toBeInTheDocument();
  });

  it("should disable write actions for a read-only viewer", () => {
    renderActions({
      canMutateTenant: false,
      failedCount: 1,
      completeCount: 1,
      detail: detail({ status: "READY", scoringLocked: false }),
    });
    expect(btn("event_detail.back_to_list")).not.toBeDisabled();
    expect(btn("event_detail.deploy_button")).toBeDisabled();
    expect(btn("event_detail.retry_failed")).toBeDisabled();
    expect(btn("event_detail.redeploy")).toBeDisabled();
    expect(btn("event_detail.end_event")).toBeDisabled();
    expect(btn("event_detail.scoring_lock")).toBeDisabled();
  });

  it("should disable retry/redeploy while another bulk op is in flight and disable scoring lock without an API client", () => {
    renderActions({
      detail: detail({ status: "READY" }),
      failedCount: 1,
      completeCount: 1,
      bulkInFlight: "deploy",
      apiClient: null,
    });
    expect(btn("event_detail.retry_failed")).toBeDisabled();
    expect(btn("event_detail.redeploy")).toBeDisabled();
    expect(btn("event_detail.scoring_lock")).toBeDisabled(); // !apiClient
  });
});
