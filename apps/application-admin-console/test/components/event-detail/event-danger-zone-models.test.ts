import { describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { buildEventDangerZoneController } from "../../../src/components/event-detail/event-danger-zone-models";
import type { AppConfig } from "../../../src/config";
import type { EndsAtValidation, useEventOperations } from "../../../src/hooks/useEventOperations";

/**
 * Issue #2020: `buildEventDangerZoneController` adapts the flat `useEventOperations` return into the
 * grouped per-operation models the danger zone consumes. This pins (a) each model field maps to the
 * right hook field, (b) every action closure delegates to the matching `operations.*`, and
 * (c) the `scheduleInFlight === "scheduled"` / `errorText !== undefined` branches both ways.
 */
type EventOperations = ReturnType<typeof useEventOperations>;

/** A fully-spied flat operations object so every action closure can be asserted by call. */
function makeOperations(over: Partial<EventOperations> = {}): EventOperations {
  return {
    bulkInFlight: null,
    bulkResult: null,
    confirmEnd: false,
    confirmForceArchive: false,
    confirmTeardown: false,
    deployDate: "",
    deployScheduleInFlight: false,
    deployScheduleModalOpen: false,
    deployTime: "",
    endInFlight: false,
    endsAtDate: "",
    endsAtInFlight: false,
    endsAtModalOpen: false,
    endsAtTime: "",
    forceArchiveInFlight: false,
    freezeMinutesInFlight: false,
    freezeMinutesInput: "",
    handleBulkDeploy: vi.fn(),
    handleBulkTeardown: vi.fn(),
    handleEndEvent: vi.fn(),
    handleEndNowSchedule: vi.fn(),
    handleForceArchive: vi.fn(),
    handleLockScoring: vi.fn(),
    handleSaveFreezeMinutes: vi.fn(),
    handleScheduleDeploy: vi.fn(),
    handleScheduleEnd: vi.fn(),
    handleScheduleTeardown: vi.fn(),
    handleScheduledStart: vi.fn(),
    handleStartNow: vi.fn(),
    handleUnlockScoring: vi.fn(),
    notifyJustSent: false,
    notifyModalOpen: false,
    scheduleDate: "",
    scheduleInFlight: null,
    scheduleModalOpen: false,
    scheduleTime: "",
    scoringLockInFlight: null,
    setBulkResult: vi.fn(),
    setConfirmEnd: vi.fn(),
    setConfirmForceArchive: vi.fn(),
    setConfirmTeardown: vi.fn(),
    setDeployDate: vi.fn(),
    setDeployScheduleModalOpen: vi.fn(),
    setDeployTime: vi.fn(),
    setEndsAtDate: vi.fn(),
    setEndsAtModalOpen: vi.fn(),
    setEndsAtTime: vi.fn(),
    setFreezeMinutesInput: vi.fn(),
    setNotifyJustSent: vi.fn(),
    setNotifyModalOpen: vi.fn(),
    setScheduleDate: vi.fn(),
    setScheduleModalOpen: vi.fn(),
    setScheduleTime: vi.fn(),
    setTeardownDate: vi.fn(),
    setTeardownModalOpen: vi.fn(),
    setTeardownTime: vi.fn(),
    teardownDate: "",
    teardownInFlight: false,
    teardownModalOpen: false,
    teardownTime: "",
    ...over,
  } as EventOperations;
}

const eventContext = {
  canMutateTenant: true,
  config: {} as AppConfig,
  detail: { startsAt: "2026-06-01T00:00:00Z" } as EventDetail,
  eventId: "evt-1",
};
const endsAtResolution = {
  validation: { canSubmit: true } as EndsAtValidation,
  errorText: undefined as string | undefined,
};

describe("buildEventDangerZoneController", () => {
  it("should map every display-state field from the flat operations return", () => {
    const operations = makeOperations({
      confirmEnd: true,
      endInFlight: true,
      confirmForceArchive: true,
      forceArchiveInFlight: true,
      confirmTeardown: true,
      scheduleModalOpen: true,
      scheduleInFlight: "scheduled",
      scheduleDate: "2026-06-01",
      scheduleTime: "10:00",
      endsAtModalOpen: true,
      endsAtInFlight: true,
      endsAtDate: "2026-06-02",
      endsAtTime: "18:00",
      teardownModalOpen: true,
      teardownInFlight: true,
      teardownDate: "2026-06-03",
      teardownTime: "09:00",
      deployScheduleModalOpen: true,
      deployScheduleInFlight: true,
      deployDate: "2026-06-04",
      deployTime: "08:00",
      notifyModalOpen: true,
      notifyJustSent: true,
    });
    const c = buildEventDangerZoneController(operations, {
      eventContext,
      endsAt: { validation: { canSubmit: false } as EndsAtValidation, errorText: "boom" },
    });

    expect(c.eventContext).toBe(eventContext);
    expect(c.endEvent).toMatchObject({ open: true, inFlight: true });
    expect(c.forceArchive).toMatchObject({ open: true, inFlight: true });
    expect(c.teardown.open).toBe(true);
    expect(c.schedule).toMatchObject({
      open: true,
      inFlight: true, // scheduleInFlight === "scheduled"
      date: "2026-06-01",
      time: "10:00",
    });
    expect(c.endsAt).toMatchObject({
      open: true,
      inFlight: true,
      date: "2026-06-02",
      time: "18:00",
      errorText: "boom",
      invalid: true, // errorText !== undefined
    });
    expect(c.teardownSchedule).toMatchObject({
      open: true,
      inFlight: true,
      date: "2026-06-03",
      time: "09:00",
    });
    expect(c.deploySchedule).toMatchObject({
      open: true,
      inFlight: true,
      date: "2026-06-04",
      time: "08:00",
    });
    expect(c.notification).toMatchObject({ modalOpen: true, justSent: true });
  });

  it("should treat a non-scheduled in-flight phase and a missing error text as false", () => {
    // scheduleInFlight="now" (= start-now phase) → schedule.inFlight false。 errorText undefined →
    // invalid false。 両 branch の false 側を踏む。
    const operations = makeOperations({ scheduleInFlight: "now" });
    const c = buildEventDangerZoneController(operations, {
      eventContext,
      endsAt: endsAtResolution,
    });
    expect(c.schedule.inFlight).toBe(false);
    expect(c.endsAt.invalid).toBe(false);
    expect(c.endsAt.errorText).toBeUndefined();
  });

  it("should delegate every action closure to the matching operations handler / setter", () => {
    const operations = makeOperations();
    const c = buildEventDangerZoneController(operations, {
      eventContext,
      endsAt: endsAtResolution,
    });

    c.endEvent.execute();
    expect(operations.handleEndEvent).toHaveBeenCalled();
    c.endEvent.dismiss();
    expect(operations.setConfirmEnd).toHaveBeenCalledWith(false);

    c.forceArchive.execute();
    expect(operations.handleForceArchive).toHaveBeenCalled();
    c.forceArchive.dismiss();
    expect(operations.setConfirmForceArchive).toHaveBeenCalledWith(false);

    c.teardown.execute();
    expect(operations.handleBulkTeardown).toHaveBeenCalled();
    c.teardown.dismiss();
    expect(operations.setConfirmTeardown).toHaveBeenCalledWith(false);

    c.schedule.submit();
    expect(operations.handleScheduledStart).toHaveBeenCalled();
    c.schedule.dismiss();
    expect(operations.setScheduleModalOpen).toHaveBeenCalledWith(false);
    c.schedule.setDate("d");
    expect(operations.setScheduleDate).toHaveBeenCalledWith("d");
    c.schedule.setTime("t");
    expect(operations.setScheduleTime).toHaveBeenCalledWith("t");

    c.endsAt.submit();
    expect(operations.handleScheduleEnd).toHaveBeenCalled();
    c.endsAt.dismiss();
    expect(operations.setEndsAtModalOpen).toHaveBeenCalledWith(false);
    c.endsAt.setDate("d");
    expect(operations.setEndsAtDate).toHaveBeenCalledWith("d");
    c.endsAt.setTime("t");
    expect(operations.setEndsAtTime).toHaveBeenCalledWith("t");

    c.teardownSchedule.submit();
    expect(operations.handleScheduleTeardown).toHaveBeenCalled();
    c.teardownSchedule.dismiss();
    expect(operations.setTeardownModalOpen).toHaveBeenCalledWith(false);
    c.teardownSchedule.setDate("d");
    expect(operations.setTeardownDate).toHaveBeenCalledWith("d");
    c.teardownSchedule.setTime("t");
    expect(operations.setTeardownTime).toHaveBeenCalledWith("t");

    c.deploySchedule.submit();
    expect(operations.handleScheduleDeploy).toHaveBeenCalled();
    c.deploySchedule.dismiss();
    expect(operations.setDeployScheduleModalOpen).toHaveBeenCalledWith(false);
    c.deploySchedule.setDate("d");
    expect(operations.setDeployDate).toHaveBeenCalledWith("d");
    c.deploySchedule.setTime("t");
    expect(operations.setDeployTime).toHaveBeenCalledWith("t");

    c.notification.dismissModal();
    expect(operations.setNotifyModalOpen).toHaveBeenCalledWith(false);
    c.notification.dismissSuccess();
    expect(operations.setNotifyJustSent).toHaveBeenCalledWith(false);
    // onSuccess closes the modal and raises the just-sent alert (2 setters).
    c.notification.onSuccess();
    expect(operations.setNotifyModalOpen).toHaveBeenCalledWith(false);
    expect(operations.setNotifyJustSent).toHaveBeenCalledWith(true);
  });
});
