import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useState } from "react";
import { ApiError, useApiClient } from "../api/client";
import { createNotification } from "../api/events-client";
import type { AppConfig } from "../config";

const SEVERITY_OPTIONS: ReadonlyArray<{ value: "info" | "warning"; label: string }> = [
  { value: "info", label: "Info (普通の通知)" },
  { value: "warning", label: "Warning (注意喚起)" },
];

const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * 運営 → 競技者 通知発信 modal (ADR-006 D6)。
 *
 * EventDetail の Header actions から呼ばれ、送信したら親側で `onSuccess` が呼ばれて
 * 親が再 fetch (= 履歴表示は本 PR スコープ外、将来 GET /events/:eventId/notifications
 * 追加時に列挙)。失敗 (validation_failed / not_found / 500) は modal 内 Alert で表示。
 */
export function SendNotificationModal({
  config,
  visible,
  eventId,
  onDismiss,
  onSuccess,
}: {
  config: AppConfig;
  visible: boolean;
  eventId: string;
  onDismiss: () => void;
  onSuccess: () => void;
}) {
  const apiClient = useApiClient(config);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning">("info");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setBody("");
    setSeverity("info");
    setError(null);
  };

  const handleDismiss = () => {
    if (inFlight) return;
    reset();
    onDismiss();
  };

  const handleSubmit = async () => {
    if (!apiClient) return;
    if (title.length === 0 || title.length > TITLE_MAX) return;
    if (body.length === 0 || body.length > BODY_MAX) return;
    setInFlight(true);
    setError(null);
    try {
      await createNotification(apiClient, eventId, { title, body, severity });
      reset();
      onSuccess();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setError(message);
    } finally {
      setInFlight(false);
    }
  };

  const titleInvalid = title.length > TITLE_MAX;
  const bodyInvalid = body.length > BODY_MAX;
  const submitDisabled =
    !apiClient ||
    inFlight ||
    title.length === 0 ||
    body.length === 0 ||
    titleInvalid ||
    bodyInvalid;

  return (
    <Modal
      visible={visible}
      onDismiss={handleDismiss}
      header="通知を送る"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={handleDismiss} disabled={inFlight}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              loading={inFlight}
              disabled={submitDisabled}
              onClick={handleSubmit}
            >
              送信
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && (
          <Alert type="error" header="送信に失敗しました">
            {error}
          </Alert>
        )}
        <FormField
          label="タイトル"
          description={`1〜${TITLE_MAX} 文字`}
          errorText={titleInvalid ? `${TITLE_MAX} 文字以内で入力してください` : undefined}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.detail.value)}
            placeholder="14:30 から scoring を再開します"
            disabled={inFlight}
          />
        </FormField>
        <FormField
          label="本文"
          description={`1〜${BODY_MAX} 文字`}
          errorText={bodyInvalid ? `${BODY_MAX} 文字以内で入力してください` : undefined}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.detail.value)}
            placeholder="メンテナンスのため一時停止していた scoring を再開しました。引き続き競技を続行してください。"
            rows={6}
            disabled={inFlight}
          />
        </FormField>
        <FormField label="Severity">
          <Select
            selectedOption={
              SEVERITY_OPTIONS.find((o) => o.value === severity) ?? SEVERITY_OPTIONS[0] ?? null
            }
            options={[...SEVERITY_OPTIONS]}
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
