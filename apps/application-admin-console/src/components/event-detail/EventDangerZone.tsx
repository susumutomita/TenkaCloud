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
import { SendNotificationModal } from "../SendNotificationModal";
import type {
  ConfirmOperationModel,
  EndsAtOperationModel,
  EventDangerZoneController,
  NotificationOperationModel,
  ScheduleOperationModel,
  TeardownOperationModel,
} from "./event-danger-zone-models";

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

/**
 * Issue #2020: each danger operation is rendered from its own grouped model (see
 * `event-danger-zone-models.ts`). Modal subcomponents below read exactly one model, so the
 * page-level wiring is one `controller` prop rather than ~50 loose props.
 */

/** End-event confirmation modal: confirm-and-end-now (no input). */
function EndEventModal({
  canMutateTenant,
  model,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly model: ConfirmOperationModel;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={model.open}
      header={t("event_detail.modal_end_event_header")}
      onDismiss={model.dismiss}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button variant="primary" disabled={!canMutateTenant} onClick={model.execute}>
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
  );
}

/** Force-archive rescue modal for a stack stuck in ROLLBACK_COMPLETE (#708). */
function ForceArchiveModal({
  canMutateTenant,
  model,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly model: ConfirmOperationModel;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={model.open}
      header={t("event_detail.modal_force_archive_header")}
      onDismiss={model.dismiss}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              loading={model.inFlight}
              disabled={!canMutateTenant}
              onClick={model.execute}
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
  );
}

/** Bulk-teardown confirmation modal (DELETE-gated; blast radius shown from counts). */
function TeardownModal({
  canMutateTenant,
  model,
  problemCount,
  teamCount,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly model: TeardownOperationModel;
  readonly problemCount: number;
  readonly teamCount: number;
  readonly t: Translate;
}) {
  const teardownConfirm = useTeardownConfirmInput(model.open);
  return (
    <Modal
      visible={model.open}
      header={t("event_detail.modal_teardown_header")}
      onDismiss={model.dismiss}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              disabled={!canMutateTenant || !teardownConfirm.canSubmit}
              data-testid="modal-teardown-confirm"
              onClick={model.execute}
            >
              {t("event_detail.modal_teardown_confirm")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="s">
        <Alert type="warning" header={t("event_detail.modal_teardown_blast_radius_header")}>
          {t("event_detail.modal_teardown_blast_radius_body", { teamCount, problemCount })}
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
  );
}

/** Scheduled-start reservation modal (date + time). */
function ScheduleStartModal({
  canMutateTenant,
  model,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly model: ScheduleOperationModel;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={model.open}
      onDismiss={model.dismiss}
      header={t("event_detail.modal_schedule_header")}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              loading={model.inFlight}
              disabled={!canMutateTenant}
              onClick={model.submit}
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
            value={model.date}
            onChange={(e) => model.setDate(e.detail.value)}
            placeholder="YYYY/MM/DD"
          />
        </FormField>
        <FormField label={t("event_detail.modal_time_label")}>
          <TimeInput
            value={model.time}
            format="hh:mm"
            placeholder="hh:mm"
            onChange={(e) => model.setTime(e.detail.value)}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

/** Scheduled-end reservation modal (date + time + validation error text). */
function EndsAtModal({
  canMutateTenant,
  model,
  startsAt,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly model: EndsAtOperationModel;
  readonly startsAt: string | undefined;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={model.open}
      onDismiss={model.dismiss}
      header={t("event_detail.modal_endsat_header")}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              loading={model.inFlight}
              disabled={!canMutateTenant || !model.validation.canSubmit || model.inFlight}
              onClick={model.submit}
            >
              {t("event_detail.modal_schedule_confirm_label")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="s">
        <Box>{t("event_detail.modal_endsat_body")}</Box>
        {startsAt && (
          <Box variant="small" color="text-status-inactive">
            {t("event_detail.modal_endsat_starts_at_hint")}: <code>{startsAt}</code>
          </Box>
        )}
        <FormField label={t("event_detail.modal_date_label")} errorText={model.errorText}>
          <DatePicker
            value={model.date}
            onChange={(e) => model.setDate(e.detail.value)}
            placeholder="YYYY/MM/DD"
            invalid={model.invalid}
          />
        </FormField>
        <FormField label={t("event_detail.modal_time_label")} errorText={model.errorText}>
          <TimeInput
            value={model.time}
            format="hh:mm"
            placeholder="hh:mm"
            onChange={(e) => model.setTime(e.detail.value)}
            invalid={model.invalid}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

/**
 * Scheduled automatic teardown / deploy modal. The two operations are
 * structurally identical (date + time, an endsAt ordering hint), so they share one component
 * parameterised by the i18n keys; only the model and the labels differ.
 */
function ScheduleWithEndsAtHintModal({
  canMutateTenant,
  endsAt,
  i18n,
  model,
  t,
}: {
  readonly canMutateTenant: boolean;
  readonly endsAt: string | undefined;
  readonly i18n: {
    readonly header: string;
    readonly body: string;
    readonly endsAtHint: string;
    readonly confirm: string;
  };
  readonly model: ScheduleOperationModel;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={model.open}
      onDismiss={model.dismiss}
      header={t(i18n.header)}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={model.dismiss}>{t("event_detail.modal_cancel")}</Button>
            <Button
              variant="primary"
              loading={model.inFlight}
              disabled={!canMutateTenant || model.inFlight}
              onClick={model.submit}
            >
              {t(i18n.confirm)}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="s">
        <Box>{t(i18n.body)}</Box>
        {endsAt && (
          <Box variant="small" color="text-status-inactive">
            {t(i18n.endsAtHint)}: <code>{endsAt}</code>
          </Box>
        )}
        <FormField label={t("event_detail.modal_date_label")}>
          <DatePicker
            value={model.date}
            onChange={(e) => model.setDate(e.detail.value)}
            placeholder="YYYY/MM/DD"
          />
        </FormField>
        <FormField label={t("event_detail.modal_time_label")}>
          <TimeInput
            value={model.time}
            format="hh:mm"
            placeholder="hh:mm"
            onChange={(e) => model.setTime(e.detail.value)}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

/** Send-notification modal + post-send success alert. */
function NotificationSection({
  config,
  canMutateTenant,
  eventId,
  model,
  t,
}: {
  readonly config: EventDangerZoneController["eventContext"]["config"];
  readonly canMutateTenant: boolean;
  readonly eventId: string;
  readonly model: NotificationOperationModel;
  readonly t: Translate;
}) {
  return (
    <>
      <SendNotificationModal
        config={config}
        canMutateTenant={canMutateTenant}
        visible={model.modalOpen}
        eventId={eventId}
        onDismiss={model.dismissModal}
        onSuccess={model.onSuccess}
      />
      {model.justSent && (
        <Alert
          type="success"
          dismissible
          onDismiss={model.dismissSuccess}
          header={t("event_detail.notification_sent_header")}
        >
          {t("event_detail.notification_sent_body")}
        </Alert>
      )}
    </>
  );
}

/**
 * The Event Detail danger zone: every confirm / schedule / notification modal for an event.
 *
 * Issue #2020 reshaped the prop surface from ~50 loose props into a single `controller`
 * (see `event-danger-zone-models.ts`). Each modal subcomponent reads exactly one operation model,
 * which keeps the page → danger-zone seam narrow as new operational features are added.
 */
export function EventDangerZone({
  controller,
  t,
}: {
  readonly controller: EventDangerZoneController;
  readonly t: Translate;
}) {
  const { eventContext } = controller;
  const { canMutateTenant, config, detail, eventId } = eventContext;
  return (
    <>
      <EndEventModal canMutateTenant={canMutateTenant} model={controller.endEvent} t={t} />
      <ForceArchiveModal canMutateTenant={canMutateTenant} model={controller.forceArchive} t={t} />
      <TeardownModal
        canMutateTenant={canMutateTenant}
        model={controller.teardown}
        problemCount={detail?.problems.length ?? 0}
        teamCount={detail?.teams.length ?? 0}
        t={t}
      />
      <ScheduleStartModal canMutateTenant={canMutateTenant} model={controller.schedule} t={t} />
      <EndsAtModal
        canMutateTenant={canMutateTenant}
        model={controller.endsAt}
        startsAt={detail?.startsAt}
        t={t}
      />
      <ScheduleWithEndsAtHintModal
        canMutateTenant={canMutateTenant}
        endsAt={detail?.endsAt}
        i18n={{
          header: "event_detail.modal_teardown_schedule_header",
          body: "event_detail.modal_teardown_schedule_body",
          endsAtHint: "event_detail.modal_teardown_ends_at_hint",
          confirm: "event_detail.modal_teardown_schedule_confirm",
        }}
        model={controller.teardownSchedule}
        t={t}
      />
      <ScheduleWithEndsAtHintModal
        canMutateTenant={canMutateTenant}
        endsAt={detail?.endsAt}
        i18n={{
          header: "event_detail.modal_deploy_schedule_header",
          body: "event_detail.modal_deploy_schedule_body",
          endsAtHint: "event_detail.modal_deploy_ends_at_hint",
          confirm: "event_detail.modal_deploy_schedule_confirm",
        }}
        model={controller.deploySchedule}
        t={t}
      />
      <NotificationSection
        config={config}
        canMutateTenant={canMutateTenant}
        eventId={eventId}
        model={controller.notification}
        t={t}
      />
    </>
  );
}
