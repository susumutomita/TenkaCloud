import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import { useT } from "../../i18n";

interface CompetitorAccountDeleteModalProps {
  target: CompetitorAccountSummary | null;
  inFlight: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}

export function CompetitorAccountDeleteModal({
  target,
  inFlight,
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
            <Button variant="primary" loading={inFlight} onClick={onConfirm}>
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
      <p>{t("competitor_accounts.delete_modal_body_2")}</p>
    </Modal>
  );
}
