import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import DatePicker from "@cloudscape-design/components/date-picker";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TimeInput from "@cloudscape-design/components/time-input";
import { useEffect, useState } from "react";
import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";
import type { EndsAtValidation } from "../../hooks/useEventOperations";
import { SendNotificationModal } from "../SendNotificationModal";

/**
 * Issue #1350: Bulk teardown は 「DELETE」 と入力させない限り confirm button を活性化しない。
 * undo 不可な操作なので誤クリックでの誤発火を防ぐ。
 *
 * (一括 redeploy も似た性質だが、 redeploy は既存 stack 更新で復旧可能なので別 modal で扱う。)
 */
const TEARDOWN_CONFIRM_TEXT = "DELETE";

function useTeardownConfirmInput(modalOpen: boolean): {
  readonly input: string;
  readonly setInput: (next: string) => void;
  readonly canSubmit: boolean;
} {
  const [input, setInput] = useState("");
  useEffect(() => {
    // modal を閉じた / 再オープン時に毎回入力をリセット。
    if (!modalOpen) setInput("");
  }, [modalOpen]);
  return {
    input,
    setInput,
    canSubmit: input.trim().toUpperCase() === TEARDOWN_CONFIRM_TEXT,
  };
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventDangerZone({
  canMutateTenant,
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
  onDismissTeardownSchedule,
  onScheduleTeardown,
  setEndsAtDate,
  setEndsAtTime,
  setScheduleDate,
  setScheduleTime,
  setTeardownDate,
  setTeardownTime,
  teardownDate,
  teardownInFlight,
  teardownModalOpen,
  teardownTime,
  t,
}: {
  readonly canMutateTenant: boolean;
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
  readonly onDismissTeardownSchedule: () => void;
  readonly onScheduleTeardown: () => void;
  readonly setEndsAtDate: (value: string) => void;
  readonly setEndsAtTime: (value: string) => void;
  readonly setScheduleDate: (value: string) => void;
  readonly setScheduleTime: (value: string) => void;
  readonly setTeardownDate: (value: string) => void;
  readonly setTeardownTime: (value: string) => void;
  readonly teardownDate: string;
  readonly teardownInFlight: boolean;
  readonly teardownModalOpen: boolean;
  readonly teardownTime: string;
  readonly t: Translate;
}) {
  const teardownConfirm = useTeardownConfirmInput(confirmTeardown);
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
              <Button variant="primary" disabled={!canMutateTenant} onClick={onEndEvent}>
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
                disabled={!canMutateTenant}
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
              <Button
                variant="primary"
                disabled={!canMutateTenant || !teardownConfirm.canSubmit}
                data-testid="modal-teardown-confirm"
                onClick={onBulkTeardown}
              >
                {t("event_detail.modal_teardown_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Alert type="warning" header={t("event_detail.modal_teardown_blast_radius_header")}>
            {t("event_detail.modal_teardown_blast_radius_body", {
              teamCount: detail?.teams.length ?? 0,
              problemCount: detail?.problems.length ?? 0,
            })}
          </Alert>
          <Box>{t("event_detail.modal_teardown_body")}</Box>
          <Box variant="small" color="text-status-warning">
            {t("event_detail.modal_teardown_extra")}
          </Box>
          <FormField
            label={t("event_detail.modal_teardown_confirm_input_label")}
            description={t("event_detail.modal_teardown_confirm_input_description")}
          >
            <Input
              value={teardownConfirm.input}
              onChange={(e) => teardownConfirm.setInput(e.detail.value)}
              placeholder={TEARDOWN_CONFIRM_TEXT}
              data-testid="modal-teardown-confirm-input"
            />
          </FormField>
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
                disabled={!canMutateTenant}
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
                disabled={!canMutateTenant || !endsAtValidation.canSubmit || endsAtInFlight}
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

      <Modal
        visible={teardownModalOpen}
        onDismiss={onDismissTeardownSchedule}
        header={t("event_detail.modal_teardown_schedule_header")}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={onDismissTeardownSchedule}>{t("event_detail.modal_cancel")}</Button>
              <Button
                variant="primary"
                loading={teardownInFlight}
                disabled={!canMutateTenant || teardownInFlight}
                onClick={onScheduleTeardown}
              >
                {t("event_detail.modal_teardown_schedule_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_teardown_schedule_body")}</Box>
          {detail?.endsAt && (
            <Box variant="small" color="text-status-inactive">
              {t("event_detail.modal_teardown_ends_at_hint")}: <code>{detail.endsAt}</code>
            </Box>
          )}
          <FormField label={t("event_detail.modal_date_label")}>
            <DatePicker
              value={teardownDate}
              onChange={(e) => setTeardownDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
            />
          </FormField>
          <FormField label={t("event_detail.modal_time_label")}>
            <TimeInput
              value={teardownTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setTeardownTime(e.detail.value)}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <SendNotificationModal
        config={config}
        canMutateTenant={canMutateTenant}
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
