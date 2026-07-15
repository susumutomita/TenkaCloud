import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { RotateTeamLoginKeyResponse, TeamSummary } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function TeamLoginKeyRotationModal({
  error,
  inFlight,
  onClose,
  onConfirm,
  result,
  team,
  t,
}: {
  readonly error: string | null;
  readonly inFlight: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly result: RotateTeamLoginKeyResponse | null;
  readonly team: TeamSummary | null;
  readonly t: Translate;
}) {
  return (
    <Modal
      visible={team !== null}
      onDismiss={inFlight ? undefined : onClose}
      header={t("event_detail.rotate_key_header", { slug: team?.internalSlug ?? "" })}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onClose} disabled={inFlight}>
              {result ? t("event_detail.rotate_key_done") : t("event_detail.modal_cancel")}
            </Button>
            {!result && (
              <Button variant="primary" loading={inFlight} onClick={onConfirm}>
                {t("event_detail.rotate_key_confirm")}
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {error && <Alert type="error">{error}</Alert>}
        {result ? (
          <>
            <Alert type="success" header={t("event_detail.rotate_key_success_header")}>
              {t("event_detail.rotate_key_success_body")}
            </Alert>
            <Box variant="code">{result.teamLoginKey}</Box>
            <Button
              iconName="copy"
              onClick={() => void navigator.clipboard?.writeText(result.teamLoginKey)}
            >
              {t("event_detail.rotate_key_copy")}
            </Button>
          </>
        ) : (
          <Alert type="warning" header={t("event_detail.rotate_key_warning_header")}>
            {t("event_detail.rotate_key_warning_body")}
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
