import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventDangerZone } from "../../../src/components/event-detail/EventDangerZone";
import type { AppConfig } from "../../../src/config";
import type { EndsAtValidation } from "../../../src/hooks/useEventOperations";

/**
 * Issue #1350: EventDangerZone (end / force-archive / teardown / schedule-start / ends-at /
 * notification の確認 modal 群)。 各 modal の confirm/cancel callback、 teardown 確認入力
 * (DELETE で活性化)、 schedule・ends-at の DatePicker/TimeInput onChange、 notification success
 * alert を pin する。 子 SendNotificationModal は stub、 props は fixture、 t は echo。
 */
vi.mock("../../../src/components/SendNotificationModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  SendNotificationModal: (p: any) =>
    p.visible ? (
      <div data-testid="send-notification-modal">
        <button type="button" onClick={p.onSuccess}>
          stub-notify-success
        </button>
        <button type="button" onClick={p.onDismiss}>
          stub-notify-dismiss
        </button>
      </div>
    ) : null,
}));

type Props = Parameters<typeof EventDangerZone>[0];
const props = (over: Partial<Props> = {}): Props =>
  ({
    canMutateTenant: true,
    config: {} as AppConfig,
    confirmEnd: false,
    confirmForceArchive: false,
    confirmTeardown: false,
    detail: {
      teams: [{}],
      problems: [{}],
      startsAt: "2026-06-01T00:00:00Z",
    } as unknown as EventDetail,
    endsAtDate: "",
    endsAtErrorText: undefined,
    endsAtInFlight: false,
    endsAtInvalid: false,
    endsAtModalOpen: false,
    endsAtTime: "",
    endsAtValidation: { canSubmit: true } as EndsAtValidation,
    eventId: "e1",
    forceArchiveInFlight: false,
    notifyJustSent: false,
    notifyModalOpen: false,
    onBulkTeardown: vi.fn(),
    onDismissEnd: vi.fn(),
    onDismissEndsAt: vi.fn(),
    onDismissForceArchive: vi.fn(),
    onDismissNotification: vi.fn(),
    onDismissNotificationSuccess: vi.fn(),
    onDismissSchedule: vi.fn(),
    onDismissTeardown: vi.fn(),
    onEndEvent: vi.fn(),
    onForceArchive: vi.fn(),
    onNotificationSuccess: vi.fn(),
    onScheduleEnd: vi.fn(),
    onScheduleTeardown: vi.fn(),
    onScheduledStart: vi.fn(),
    onDismissTeardownSchedule: vi.fn(),
    scheduleDate: "",
    scheduleInFlight: null,
    scheduleModalOpen: false,
    scheduleTime: "",
    setEndsAtDate: vi.fn(),
    setEndsAtTime: vi.fn(),
    setScheduleDate: vi.fn(),
    setScheduleTime: vi.fn(),
    setTeardownDate: vi.fn(),
    setTeardownTime: vi.fn(),
    teardownDate: "",
    teardownInFlight: false,
    teardownModalOpen: false,
    teardownTime: "",
    t: (k: string) => k,
    ...over,
  }) as Props;

afterEach(() => vi.clearAllMocks());

describe("EventDangerZone", () => {
  it("should confirm end / force-archive / teardown (DELETE-gated) and cancel each", () => {
    const p = props({ confirmEnd: true, confirmForceArchive: true, confirmTeardown: true });
    render(<EventDangerZone {...p} />);
    // teardown blast-radius は teams/problems 件数を出す。
    expect(screen.getByText("event_detail.modal_teardown_blast_radius_body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "event_detail.modal_end_event_confirm" }));
    expect(p.onEndEvent).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("force-archive-confirm"));
    expect(p.onForceArchive).toHaveBeenCalled();

    // teardown confirm は DELETE 入力まで disabled。
    const teardownBtn = screen.getByTestId("modal-teardown-confirm");
    expect(teardownBtn).toBeDisabled();
    const input = screen.getByTestId("modal-teardown-confirm-input").querySelector("input");
    fireEvent.change(input as HTMLInputElement, { target: { value: "DELETE" } });
    expect(screen.getByTestId("modal-teardown-confirm")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("modal-teardown-confirm"));
    expect(p.onBulkTeardown).toHaveBeenCalled();

    // 各 modal の cancel (modal_cancel) → end / force-archive / teardown の順。
    const cancels = screen.getAllByRole("button", { name: "event_detail.modal_cancel" });
    fireEvent.click(cancels[0] as HTMLElement);
    fireEvent.click(cancels[1] as HTMLElement);
    fireEvent.click(cancels[2] as HTMLElement);
    expect(p.onDismissEnd).toHaveBeenCalled();
    expect(p.onDismissForceArchive).toHaveBeenCalled();
    expect(p.onDismissTeardown).toHaveBeenCalled();
  });

  it("should drive the schedule-start and ends-at date/time inputs and confirms", () => {
    const p = props({ scheduleModalOpen: true, endsAtModalOpen: true });
    render(<EventDangerZone {...p} />);
    expect(screen.getByText(/event_detail\.modal_endsat_starts_at_hint/)).toBeInTheDocument(); // detail.startsAt hint

    // Cloudscape DatePicker/TimeInput は入力値を正規化するので、 onChange が発火したことだけ pin。
    const dates = screen.getAllByPlaceholderText("YYYY/MM/DD"); // [0]=schedule, [1]=ends-at
    fireEvent.change(dates[0] as HTMLElement, { target: { value: "2026/06/01" } });
    expect(p.setScheduleDate).toHaveBeenCalled();
    fireEvent.change(dates[1] as HTMLElement, { target: { value: "2026/06/02" } });
    expect(p.setEndsAtDate).toHaveBeenCalled();

    const times = screen.getAllByPlaceholderText("hh:mm");
    fireEvent.change(times[0] as HTMLElement, { target: { value: "10:00" } });
    expect(p.setScheduleTime).toHaveBeenCalled();
    fireEvent.change(times[1] as HTMLElement, { target: { value: "18:00" } });
    expect(p.setEndsAtTime).toHaveBeenCalled();

    // 両 modal の confirm (modal_schedule_confirm_label) → schedule-start / ends-at の順。
    const confirms = screen.getAllByRole("button", {
      name: "event_detail.modal_schedule_confirm_label",
    });
    fireEvent.click(confirms[0] as HTMLElement);
    expect(p.onScheduledStart).toHaveBeenCalled();
    fireEvent.click(confirms[1] as HTMLElement);
    expect(p.onScheduleEnd).toHaveBeenCalled();
  });

  it("should render the teardown blast-radius with zero counts when detail is null", () => {
    render(<EventDangerZone {...props({ confirmTeardown: true, detail: null })} />);
    // detail?.teams.length ?? 0 / detail?.problems.length ?? 0 の null 経路。
    expect(screen.getByText("event_detail.modal_teardown_blast_radius_body")).toBeInTheDocument();
  });

  it("should disable modal confirmations for a read-only viewer", () => {
    render(
      <EventDangerZone
        {...props({
          canMutateTenant: false,
          confirmEnd: true,
          confirmForceArchive: true,
          confirmTeardown: true,
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "event_detail.modal_end_event_confirm" }),
    ).toBeDisabled();
    expect(screen.getByTestId("force-archive-confirm")).toBeDisabled();
    const input = screen.getByTestId("modal-teardown-confirm-input").querySelector("input");
    fireEvent.change(input as HTMLInputElement, { target: { value: "DELETE" } });
    expect(screen.getByTestId("modal-teardown-confirm")).toBeDisabled();
  });

  it("should drive the teardown-schedule modal inputs and confirm/cancel (ADR-047)", () => {
    const p = props({
      teardownModalOpen: true,
      detail: {
        teams: [{}],
        problems: [{}],
        endsAt: "2026-06-02T00:00:00Z",
      } as unknown as EventDetail,
    });
    render(<EventDangerZone {...p} />);
    // Cloudscape は他 modal も DOM に描画するため、 teardown dialog に scope する。
    const modal = within(
      screen.getByRole("dialog", { name: "event_detail.modal_teardown_schedule_header" }),
    );
    expect(modal.getByText("event_detail.modal_teardown_schedule_body")).toBeInTheDocument();
    // endsAt hint (truthy 経路)。
    expect(modal.getByText(/event_detail\.modal_teardown_ends_at_hint/)).toBeInTheDocument();

    fireEvent.change(modal.getByPlaceholderText("YYYY/MM/DD"), { target: { value: "2026/06/03" } });
    expect(p.setTeardownDate).toHaveBeenCalled();
    fireEvent.change(modal.getByPlaceholderText("hh:mm"), { target: { value: "10:00" } });
    expect(p.setTeardownTime).toHaveBeenCalled();

    fireEvent.click(
      modal.getByRole("button", { name: "event_detail.modal_teardown_schedule_confirm" }),
    );
    expect(p.onScheduleTeardown).toHaveBeenCalled();
    fireEvent.click(modal.getByRole("button", { name: "event_detail.modal_cancel" }));
    expect(p.onDismissTeardownSchedule).toHaveBeenCalled();
  });

  it("should hide the teardown ends-at hint without an end time and disable confirm in-flight / read-only", () => {
    // endsAt 不在 → hint 非表示 (falsy 経路)。
    const { rerender } = render(<EventDangerZone {...props({ teardownModalOpen: true })} />);
    expect(screen.queryByText(/event_detail\.modal_teardown_ends_at_hint/)).toBeNull();
    const confirmName = { name: "event_detail.modal_teardown_schedule_confirm" };
    rerender(<EventDangerZone {...props({ teardownModalOpen: true, teardownInFlight: true })} />);
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
    rerender(<EventDangerZone {...props({ teardownModalOpen: true, canMutateTenant: false })} />);
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
  });

  it("should wire the notification modal and dismiss the just-sent success alert", () => {
    const p = props({ notifyModalOpen: true, notifyJustSent: true });
    render(<EventDangerZone {...p} />);
    fireEvent.click(screen.getByText("stub-notify-success"));
    expect(p.onNotificationSuccess).toHaveBeenCalled();
    fireEvent.click(screen.getByText("stub-notify-dismiss"));
    expect(p.onDismissNotification).toHaveBeenCalled();
    // notifyJustSent → success alert + dismiss。
    expect(screen.getByText("event_detail.notification_sent_body")).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    expect(p.onDismissNotificationSuccess).toHaveBeenCalled();
  });
});
