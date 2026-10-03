import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { ApiError } from "@tenkacloud/web-kit";
import { useT } from "../../i18n";

/** The API has rejected creation before it generates keys or writes any event/team. */
export function hostingAccountRequiringConsent(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined;
  try {
    const body = JSON.parse(error.message.replace(/^API 422: /u, ""));
    return body.error === "unsupported_hosting_account" &&
      typeof body.awsAccountId === "string" &&
      /^\d{12}$/u.test(body.awsAccountId)
      ? body.awsAccountId
      : undefined;
  } catch {
    return undefined;
  }
}

export function EventCreateSelfTestModal({
  visible,
  awsAccountId,
  onCancel,
  onConfirm,
}: {
  readonly visible: boolean;
  readonly awsAccountId: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal
      data-testid="self-test-prompt"
      visible={visible}
      header={t("event_create.self_test_header")}
      onDismiss={onCancel}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onCancel}>{t("event_create.cancel")}</Button>
            <Button variant="primary" onClick={onConfirm}>
              {t("event_create.self_test_confirm")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box>{t("event_create.self_test_account", { account: awsAccountId })}</Box>
        <Alert type="warning">{t("event_create.self_test_risk")}</Alert>
        <Box>{t("event_create.self_test_recommendation")}</Box>
      </SpaceBetween>
    </Modal>
  );
}
