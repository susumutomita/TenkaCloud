/**
 * Issue #2020: Operation view models for the Event Detail danger zone.
 *
 * Background
 * ----------
 * `EventDangerZone` used to receive ~50 individual props (per-operation modal flags,
 * date / time strings, setters, submit / dismiss callbacks, validation results) directly
 * from `EventDetailLoaded`. Every new operational feature (scheduled execution, teardown,
 * approval-waiting, failure recovery) widened that flat prop list and tightened the coupling
 * between the parent page and the danger-op UI.
 *
 * This module introduces an explicit boundary: each danger operation is expressed as a small
 * *operation model* that bundles exactly what the UI needs for that one operation —
 *
 *   - its **display state** (modal open / in-flight / validation), and
 *   - its **input updates** (setDate / setTime where a modal collects a date + time), and
 *   - its **actions** (submit / execute + dismiss).
 *
 * `buildEventDangerZoneController` adapts the flat `useEventOperations` return (which stays the
 * source of truth for the actual mutation logic) into these grouped models. The page no longer
 * wires each individual input setter; it passes one `EventDangerZoneController`.
 *
 * Responsibility split (each field below is owned by exactly one model):
 *   - `eventContext`  — read-only context shared by every operation (eventId / detail /
 *                       permission / config). Operations never mutate it.
 *   - `endEvent`      — confirm-and-end-now operation (no input, just confirm / dismiss / execute).
 *   - `forceArchive`  — operator rescue for a stack stuck in ROLLBACK_COMPLETE (#708).
 *   - `teardown`      — bulk teardown confirmation (DELETE-gated; blast-radius shown by the UI).
 *   - `schedule`      — scheduled *start* reservation (date + time input).
 *   - `endsAt`        — scheduled *end* reservation (date + time input + validation error text).
 *   - `teardownSchedule` — scheduled automatic teardown (date + time input).
 *   - `deploySchedule`   — scheduled automatic deploy (date + time input).
 *   - `notification`  — send-notification modal + the post-send success alert.
 *
 * Keeping each model tiny and single-purpose is what lets the next operational feature add a new
 * model instead of threading another setter through the page → danger-zone seam.
 */

import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";
import type { EndsAtValidation, useEventOperations } from "../../hooks/useEventOperations";

/** The flat hook return that backs every operation model. */
type EventOperations = ReturnType<typeof useEventOperations>;

/** Read-only context every danger operation reads from (never mutates). */
export interface EventDangerZoneContext {
  readonly canMutateTenant: boolean;
  readonly config: AppConfig;
  readonly detail: EventDetail | null;
  readonly eventId: string;
}

/** A confirm-only destructive operation: no input, just confirm / dismiss / execute. */
export interface ConfirmOperationModel {
  /** Whether the confirmation modal is visible. */
  readonly open: boolean;
  /** Whether the execute call is in flight (drives the button spinner). */
  readonly inFlight: boolean;
  /** Close the modal without acting. */
  readonly dismiss: () => void;
  /** Run the destructive action. */
  readonly execute: () => void;
}

/**
 * Bulk teardown is confirm-only at this seam; the DELETE-typed gating lives inside the component
 * (it owns its own confirm-text input), so the model carries no in-flight flag.
 */
export interface TeardownOperationModel {
  /** Whether the confirmation modal is visible. */
  readonly open: boolean;
  /** Close the modal without acting. */
  readonly dismiss: () => void;
  /** Run the bulk teardown. */
  readonly execute: () => void;
}

/** An operation whose modal collects a date + time, then submits a schedule reservation. */
export interface ScheduleOperationModel {
  /** Whether the reservation modal is visible. */
  readonly open: boolean;
  /** Whether the submit call is in flight. */
  readonly inFlight: boolean;
  /** Current date string (`YYYY-MM-DD` from the DatePicker). */
  readonly date: string;
  /** Current time string (`HH:mm` from the TimeInput). */
  readonly time: string;
  /** Update the date input. */
  readonly setDate: (value: string) => void;
  /** Update the time input. */
  readonly setTime: (value: string) => void;
  /** Submit the reservation. */
  readonly submit: () => void;
  /** Close the modal without submitting. */
  readonly dismiss: () => void;
}

/**
 * The scheduled-end reservation additionally surfaces validation: the parent resolves an
 * `EndsAtValidation` (canSubmit + an optional i18n error key) so the modal can show errorText and
 * disable submit. `errorText` is the already-resolved string; `invalid` mirrors its presence.
 */
export interface EndsAtOperationModel extends ScheduleOperationModel {
  readonly validation: EndsAtValidation;
  readonly errorText: string | undefined;
  readonly invalid: boolean;
}

/** The send-notification modal plus its post-send success alert. */
export interface NotificationOperationModel {
  /** Whether the send-notification modal is visible. */
  readonly modalOpen: boolean;
  /** Whether the just-sent success alert is showing. */
  readonly justSent: boolean;
  /** Close the modal without sending. */
  readonly dismissModal: () => void;
  /** Dismiss the success alert. */
  readonly dismissSuccess: () => void;
  /** Called when the child modal reports a successful send (closes modal + raises the alert). */
  readonly onSuccess: () => void;
}

/**
 * The single grouped props object `EventDangerZone` consumes. Each per-operation model is
 * self-contained, so the component reads one model per modal instead of dozens of loose props.
 */
export interface EventDangerZoneController {
  readonly eventContext: EventDangerZoneContext;
  readonly endEvent: ConfirmOperationModel;
  readonly forceArchive: ConfirmOperationModel;
  readonly teardown: TeardownOperationModel;
  readonly schedule: ScheduleOperationModel;
  readonly endsAt: EndsAtOperationModel;
  readonly teardownSchedule: ScheduleOperationModel;
  readonly deploySchedule: ScheduleOperationModel;
  readonly notification: NotificationOperationModel;
}

/** What the page resolves (validation depends on `detail` + the current input, so it lives there). */
interface EndsAtResolution {
  readonly validation: EndsAtValidation;
  readonly errorText: string | undefined;
}

/**
 * Adapt the flat `useEventOperations` return into the grouped controller the danger zone consumes.
 *
 * The hook keeps owning the mutation logic; this builder only *groups* its fields so the page can
 * hand the danger zone one `controller` instead of wiring each operation's input state inline.
 */
export function buildEventDangerZoneController(
  operations: EventOperations,
  args: {
    readonly eventContext: EventDangerZoneContext;
    readonly endsAt: EndsAtResolution;
  },
): EventDangerZoneController {
  const { eventContext, endsAt } = args;
  return {
    eventContext,
    endEvent: {
      open: operations.confirmEnd,
      inFlight: operations.endInFlight,
      dismiss: () => operations.setConfirmEnd(false),
      execute: () => void operations.handleEndEvent(),
    },
    forceArchive: {
      open: operations.confirmForceArchive,
      inFlight: operations.forceArchiveInFlight,
      dismiss: () => operations.setConfirmForceArchive(false),
      execute: () => void operations.handleForceArchive(),
    },
    teardown: {
      open: operations.confirmTeardown,
      dismiss: () => operations.setConfirmTeardown(false),
      execute: () => void operations.handleBulkTeardown(),
    },
    schedule: {
      open: operations.scheduleModalOpen,
      // schedule has both a "now" and a "scheduled" in-flight phase; the modal button reflects only
      // the scheduled phase, matching the prior `scheduleInFlight === "scheduled"` check.
      inFlight: operations.scheduleInFlight === "scheduled",
      date: operations.scheduleDate,
      time: operations.scheduleTime,
      setDate: operations.setScheduleDate,
      setTime: operations.setScheduleTime,
      submit: () => void operations.handleScheduledStart(),
      dismiss: () => operations.setScheduleModalOpen(false),
    },
    endsAt: {
      open: operations.endsAtModalOpen,
      inFlight: operations.endsAtInFlight,
      date: operations.endsAtDate,
      time: operations.endsAtTime,
      setDate: operations.setEndsAtDate,
      setTime: operations.setEndsAtTime,
      submit: () => void operations.handleScheduleEnd(),
      dismiss: () => operations.setEndsAtModalOpen(false),
      validation: endsAt.validation,
      errorText: endsAt.errorText,
      invalid: endsAt.errorText !== undefined,
    },
    teardownSchedule: {
      open: operations.teardownModalOpen,
      inFlight: operations.teardownInFlight,
      date: operations.teardownDate,
      time: operations.teardownTime,
      setDate: operations.setTeardownDate,
      setTime: operations.setTeardownTime,
      submit: () => void operations.handleScheduleTeardown(),
      dismiss: () => operations.setTeardownModalOpen(false),
    },
    deploySchedule: {
      open: operations.deployScheduleModalOpen,
      inFlight: operations.deployScheduleInFlight,
      date: operations.deployDate,
      time: operations.deployTime,
      setDate: operations.setDeployDate,
      setTime: operations.setDeployTime,
      submit: () => void operations.handleScheduleDeploy(),
      dismiss: () => operations.setDeployScheduleModalOpen(false),
    },
    notification: {
      modalOpen: operations.notifyModalOpen,
      justSent: operations.notifyJustSent,
      dismissModal: () => operations.setNotifyModalOpen(false),
      dismissSuccess: () => operations.setNotifyJustSent(false),
      onSuccess: () => {
        operations.setNotifyModalOpen(false);
        operations.setNotifyJustSent(true);
      },
    },
  };
}
