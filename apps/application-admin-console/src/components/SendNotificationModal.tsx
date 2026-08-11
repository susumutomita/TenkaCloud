import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useMemo, useState } from "react";
import { ApiError, useApiClient } from "../api/client";
import { createNotification } from "../api/events-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

const TITLE_MAX = 120;
const BODY_MAX = 2000;

interface NotificationDraft {
  readonly title: string;
  readonly body: string;
}

export function isNotificationDraftValid(draft: NotificationDraft): boolean {
  return (
    draft.title.length > 0 &&
    draft.title.length <= TITLE_MAX &&
    draft.body.length > 0 &&
    draft.body.length <= BODY_MAX
  );
}

export function formatNotificationSubmitError(err: unknown): string {
  if (err instanceof ApiError) return `${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Operator → competitor notification modal (notification API).
 */
export function SendNotificationModal({
  canMutateTenant,
  config,
  visible,
  eventId,
  onDismiss,
  onSuccess,
}: {
  canMutateTenant: boolean;
  config: AppConfig;
  visible: boolean;
  eventId: string;
  onDismiss: () => void;
  onSuccess: () => void;
}) {
  const apiClient = useApiClient(config);
  const t = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning">("info");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const severityOptions = useMemo(
    () =>
      [
        { value: "info", label: t("send_notification.severity_info") },
        { value: "warning", label: t("send_notification.severity_warning") },
      ] as const,
    [t],
  );

  const reset = () => {
    setTitle("");
    setBody("");
    setSeverity("info");
    setError(null);
  };

  const handleDismiss = () => {
    // cancel button は disabled={inFlight} なので inFlight 中は押せない (= 防御、不到達)。
    /* v8 ignore next */
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const handleSubmit = async () => {
    // submit button は disabled (= !apiClient / read-only / 無効 draft / inFlight) なので、 ここに
    // 来る時点で apiClient あり & draft 有効。 = この guard の return は UI 経路では不到達 (防御)。
    /* v8 ignore next */
    if (!apiClient || !canMutateTenant || !isNotificationDraftValid({ title, body })) return;
    setInFlight(true);
    setError(null);
    try {
      await createNotification(apiClient, eventId, { title, body, severity });
      reset();
      onSuccess();
    } catch (err) {
      setError(formatNotificationSubmitError(err));
    } finally {
      setInFlight(false);
    }
  };

  const titleInvalid = title.length > TITLE_MAX;
  const bodyInvalid = body.length > BODY_MAX;
  const submitDisabled =
    !apiClient || !canMutateTenant || inFlight || !isNotificationDraftValid({ title, body });

  return (
    <Modal
      visible={visible}
      onDismiss={handleDismiss}
      header={t("send_notification.header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleDismiss} disabled={inFlight}>
              {t("send_notification.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={inFlight}
              disabled={submitDisabled}
              onClick={handleSubmit}
            >
              {t("send_notification.submit")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" header={t("send_notification.error_header")}>
            {error}
          </Alert>
        )}
        <FormField
          label={t("send_notification.title_label")}
          description={t("send_notification.title_description", { max: TITLE_MAX })}
          errorText={
            titleInvalid ? t("send_notification.title_invalid", { max: TITLE_MAX }) : undefined
          }
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.detail.value)}
            placeholder={t("send_notification.title_placeholder")}
            disabled={inFlight}
          />
        </FormField>
        <FormField
          label={t("send_notification.body_label")}
          description={t("send_notification.body_description", { max: BODY_MAX })}
          errorText={
            bodyInvalid ? t("send_notification.body_invalid", { max: BODY_MAX }) : undefined
          }
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.detail.value)}
            placeholder={t("send_notification.body_placeholder")}
            rows={6}
            disabled={inFlight}
          />
        </FormField>
        <FormField label={t("send_notification.severity_label")}>
          <Select
            selectedOption={
              // severity は常に severityOptions のいずれか → find は必ず一致 (?? 以降は防御)。
              /* v8 ignore next */
              severityOptions.find((o) => o.value === severity) ?? severityOptions[0] ?? null
            }
            options={[...severityOptions]}
            onChange={(e) => {
              const v = e.detail.selectedOption.value as "info" | "warning";
              setSeverity(v);
            }}
            disabled={inFlight}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
