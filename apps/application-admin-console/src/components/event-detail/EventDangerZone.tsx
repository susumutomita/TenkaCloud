import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import DatePicker from "@cloudscape-design/components/date-picker";
import FormField from "@cloudscape-design/components/form-field";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TimeInput from "@cloudscape-design/components/time-input";
import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";
import type { EndsAtValidation } from "../../hooks/useEventOperations";
import { SendNotificationModal } from "../SendNotificationModal";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventDangerZone({
  config,
  confirmEnd,
  confirmForceArchive,
  confirmTeardown,
  detail,
  endsAtDate,
  endsAtErrorText,
  endsAtInFlight,
  endsAtInvalid,
  endsAtModalOpen,
  endsAtTime,
  endsAtValidation,
  eventId,
  forceArchiveInFlight,
  notifyJustSent,
  notifyModalOpen,
  onBulkTeardown,
  onDismissEnd,
  onDismissEndsAt,
  onDismissForceArchive,
  onDismissNotification,
  onDismissNotificationSuccess,
  onDismissSchedule,
  onDismissTeardown,
  onEndEvent,
  onForceArchive,
  onNotificationSuccess,
  onScheduleEnd,
  onScheduledStart,
  scheduleDate,
  scheduleInFlight,
  scheduleModalOpen,
  scheduleTime,
  setEndsAtDate,
  setEndsAtTime,
  setScheduleDate,
  setScheduleTime,
  t,
}: {
  readonly config: AppConfig;
  readonly confirmEnd: boolean;
  readonly confirmForceArchive: boolean;
  readonly confirmTeardown: boolean;
  readonly detail: EventDetail | null;
  readonly endsAtDate: string;
  readonly endsAtErrorText: string | undefined;
  readonly endsAtInFlight: boolean;
  readonly endsAtInvalid: boolean;
  readonly endsAtModalOpen: boolean;
  readonly endsAtTime: string;
  readonly endsAtValidation: EndsAtValidation;
  readonly eventId: string;
  readonly forceArchiveInFlight: boolean;
  readonly notifyJustSent: boolean;
  readonly notifyModalOpen: boolean;
  readonly onBulkTeardown: () => void;
  readonly onDismissEnd: () => void;
  readonly onDismissEndsAt: () => void;
  readonly onDismissForceArchive: () => void;
  readonly onDismissNotification: () => void;
  readonly onDismissNotificationSuccess: () => void;
  readonly onDismissSchedule: () => void;
  readonly onDismissTeardown: () => void;
  readonly onEndEvent: () => void;
  readonly onForceArchive: () => void;
  readonly onNotificationSuccess: () => void;
  readonly onScheduleEnd: () => void;
  readonly onScheduledStart: () => void;
  readonly scheduleDate: string;
  readonly scheduleInFlight: "now" | "scheduled" | null;
  readonly scheduleModalOpen: boolean;
  readonly scheduleTime: string;
  readonly setEndsAtDate: (value: string) => void;
  readonly setEndsAtTime: (value: string) => void;
  readonly setScheduleDate: (value: string) => void;
  readonly setScheduleTime: (value: string) => void;
  readonly t: Translate;
}) {
  return (
    <>
      <Modal
        visible={confirmEnd}
        header={t("event_detail.modal_end_event_header")}
        onDismiss={onDismissEnd}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissEnd}>{t("event_detail.modal_cancel")}</Button>
              <Button variant="primary" onClick={onEndEvent}>
                {t("event_detail.modal_end_event_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_end_event_body")}</Box>
          <Box variant="small" color="text-status-warning">
            {t("event_detail.modal_end_event_extra")}
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmForceArchive}
        header={t("event_detail.modal_force_archive_header")}
        onDismiss={onDismissForceArchive}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissForceArchive}>{t("event_detail.modal_cancel")}</Button>
              <Button
                variant="primary"
                loading={forceArchiveInFlight}
                onClick={onForceArchive}
                data-testid="force-archive-confirm"
              >
                {t("event_detail.modal_force_archive_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_force_archive_body")}</Box>
          <Alert type="warning" header={t("event_detail.modal_force_archive_alert_header")}>
            {t("event_detail.modal_force_archive_alert_body")}
          </Alert>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmTeardown}
        header={t("event_detail.modal_teardown_header")}
        onDismiss={onDismissTeardown}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissTeardown}>{t("event_detail.modal_cancel")}</Button>
              <Button variant="primary" onClick={onBulkTeardown}>
                {t("event_detail.modal_teardown_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_teardown_body")}</Box>
          <Box variant="small" color="text-status-warning">
            {t("event_detail.modal_teardown_extra")}
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={scheduleModalOpen}
        onDismiss={onDismissSchedule}
        header={t("event_detail.modal_schedule_header")}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissSchedule}>{t("event_detail.modal_cancel")}</Button>
              <Button
                variant="primary"
                loading={scheduleInFlight === "scheduled"}
                onClick={onScheduledStart}
              >
                {t("event_detail.modal_schedule_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_schedule_body")}</Box>
          <FormField label={t("event_detail.modal_date_label")}>
            <DatePicker
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
            />
          </FormField>
          <FormField label={t("event_detail.modal_time_label")}>
            <TimeInput
              value={scheduleTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setScheduleTime(e.detail.value)}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={endsAtModalOpen}
        onDismiss={onDismissEndsAt}
        header={t("event_detail.modal_endsat_header")}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissEndsAt}>{t("event_detail.modal_cancel")}</Button>
              <Button
                variant="primary"
                loading={endsAtInFlight}
                disabled={!endsAtValidation.canSubmit || endsAtInFlight}
                onClick={onScheduleEnd}
              >
                {t("event_detail.modal_schedule_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_endsat_body")}</Box>
          {detail?.startsAt && (
            <Box variant="small" color="text-status-inactive">
              {t("event_detail.modal_endsat_starts_at_hint")}: <code>{detail.startsAt}</code>
            </Box>
          )}
          <FormField label={t("event_detail.modal_date_label")} errorText={endsAtErrorText}>
            <DatePicker
              value={endsAtDate}
              onChange={(e) => setEndsAtDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
              invalid={endsAtInvalid}
            />
          </FormField>
          <FormField label={t("event_detail.modal_time_label")} errorText={endsAtErrorText}>
            <TimeInput
              value={endsAtTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setEndsAtTime(e.detail.value)}
              invalid={endsAtInvalid}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <SendNotificationModal
        config={config}
        visible={notifyModalOpen}
        eventId={eventId}
        onDismiss={onDismissNotification}
        onSuccess={onNotificationSuccess}
      />
      {notifyJustSent && (
        <Alert
          type="success"
          dismissible
          onDismiss={onDismissNotificationSuccess}
          header={t("event_detail.notification_sent_header")}
        >
          {t("event_detail.notification_sent_body")}
        </Alert>
      )}
    </>
  );
}
