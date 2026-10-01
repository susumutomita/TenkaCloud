import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import { useT } from "../../i18n";

interface CompetitorAccountDeleteModalProps {
  target: CompetitorAccountSummary | null;
  inFlight: boolean;
  canMutateTenant: boolean;
  localHost?: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}

export function CompetitorAccountDeleteModal({
  target,
  inFlight,
  canMutateTenant,
  localHost = false,
  onDismiss,
  onConfirm,
}: CompetitorAccountDeleteModalProps) {
  const t = useT();
  return (
    <Modal
      visible={target !== null}
      onDismiss={onDismiss}
      header={t("competitor_accounts.delete_modal_header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDismiss} disabled={inFlight}>
              {t("competitor_accounts.delete_modal_cancel")}
            </Button>
            <Button
              variant="primary"
              loading={inFlight}
              disabled={!canMutateTenant}
              onClick={onConfirm}
            >
              {t("competitor_accounts.delete_modal_confirm")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <p>
        {t("competitor_accounts.delete_modal_body_1", {
          accountId: target?.awsAccountId ?? "",
        })}
      </p>
      <p>
        {t(
          localHost
            ? "competitor_accounts.host_delete_body"
            : "competitor_accounts.delete_modal_body_2",
        )}
      </p>
    </Modal>
  );
}
