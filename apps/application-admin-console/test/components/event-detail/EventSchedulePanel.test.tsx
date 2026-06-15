import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventSchedulePanel } from "../../../src/components/event-detail/EventSchedulePanel";
import type { WizardState } from "../../../src/lib/event-wizard";

/**
 * EventSchedulePanel: starts/ends at + scoring 状態 + freeze 分の編集 panel。 set/unset の
 * code vs プレースホルダ表示、 freeze の現在値 vs default、 各 button の callback と
 * disabled/loading 条件 (apiClient 不在 / scheduleInFlight now・scheduled / endsAtInFlight /
 * freezeMinutesInFlight / freeze 入力空) を pin する。 shared (Field/scoringBadge) は stub。
 */
vi.mock("../../../src/components/event-detail/shared", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  scoringBadge: () => <span data-testid="scoring-badge" />,
}));

type Props = Parameters<typeof EventSchedulePanel>[0];
const props = (over: Partial<Props> = {}): Props => ({
  apiClient: {} as never,
  canMutateTenant: true,
  detail: {
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2026-01-02T00:00:00Z",
    scoreboardFreezeMinutes: 5,
  } as unknown as EventDetail,
  endsAtInFlight: false,
  freezeMinutesInFlight: false,
  freezeMinutesInput: "30",
  onEndNowSchedule: vi.fn(),
  onOpenEndsAtModal: vi.fn(),
  onOpenScheduleModal: vi.fn(),
  onSaveFreezeMinutes: vi.fn(),
  onStartNow: vi.fn(),
  onUpdateFreezeMinutes: vi.fn(),
  scheduleInFlight: null,
  t: (k: string) => k,
  wizard: { primary: "start" } as unknown as WizardState,
  ...over,
});
const renderPanel = (over: Partial<Props> = {}) => render(<EventSchedulePanel {...props(over)} />);
const btn = (name: string) => screen.getByRole("button", { name });

afterEach(() => vi.clearAllMocks());

describe("EventSchedulePanel", () => {
  it("should render set values and fire every action callback when enabled", () => {
    const p = props();
    render(<EventSchedulePanel {...p} />);
    expect(screen.getByText("2026-01-01T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-01-02T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("event_detail.freeze_current_minutes")).toBeInTheDocument();

    fireEvent.click(btn("event_detail.starts_at_pick"));
    expect(p.onOpenScheduleModal).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.starts_at_now"));
    expect(p.onStartNow).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.ends_at_pick"));
    expect(p.onOpenEndsAtModal).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.ends_at_now"));
    expect(p.onEndNowSchedule).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "45" } });
    expect(p.onUpdateFreezeMinutes).toHaveBeenCalledWith("45");
    fireEvent.click(btn("event_detail.freeze_save"));
    expect(p.onSaveFreezeMinutes).toHaveBeenCalled();
  });

  it("should show placeholders and defaults when schedule + freeze are unset (wizard null)", () => {
    renderPanel({
      detail: {
        startsAt: undefined,
        endsAt: undefined,
        scoreboardFreezeMinutes: undefined,
      } as unknown as EventDetail,
      wizard: null,
      freezeMinutesInput: "",
    });
    expect(screen.getByText("event_detail.starts_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.ends_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.freeze_current_default")).toBeInTheDocument();
    // freeze 入力が空 → save 無効。
    expect(btn("event_detail.freeze_save")).toBeDisabled();
  });

  it("should disable every action when the API client is unavailable", () => {
    renderPanel({ apiClient: null });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled();
    expect(btn("event_detail.starts_at_now")).toBeDisabled();
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(btn("event_detail.ends_at_now")).toBeDisabled();
    expect(btn("event_detail.freeze_save")).toBeDisabled();
  });

  it("should disable every write action for a read-only viewer", () => {
    renderPanel({ canMutateTenant: false });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled();
    expect(btn("event_detail.starts_at_now")).toBeDisabled();
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(btn("event_detail.ends_at_now")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();
    expect(btn("event_detail.freeze_save")).toBeDisabled();
  });

  it("should reflect in-flight schedule states (now loading / scheduled disabling pick)", () => {
    const { rerender } = renderPanel({ scheduleInFlight: "now" });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled(); // scheduleInFlight !== null
    rerender(<EventSchedulePanel {...props({ scheduleInFlight: "scheduled" })} />);
    expect(btn("event_detail.starts_at_now")).toBeDisabled(); // === "scheduled"
  });

  it("should reflect ends-at and freeze in-flight states", () => {
    renderPanel({ endsAtInFlight: true, freezeMinutesInFlight: true });
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled(); // freeze input
  });
});
