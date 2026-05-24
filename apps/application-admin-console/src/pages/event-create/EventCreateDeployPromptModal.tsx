import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useT } from "../../i18n";

/**
 * Issue #1067: Event 作成成功後に operator へ deploy の必要性を明示する modal。
 *
 * 旧挙動 (= 即 EventDetail に navigate) では「Deploy が必要」 と気付かないまま
 * participant 側で問題が見えない silent failure が頻発していた。 modal で
 * 「いま deploy する」 / 「あとで」 の二択を明示する。
 */
export interface EventCreateDeployPromptModalProps {
  visible: boolean;
  deployStarting: boolean;
  onDeployNow: () => void;
  onDeployLater: () => void;
}

export function EventCreateDeployPromptModal({
  visible,
  deployStarting,
  onDeployNow,
  onDeployLater,
}: EventCreateDeployPromptModalProps) {
  const t = useT();
  return (
    <Modal
      visible={visible}
      onDismiss={() => (deployStarting ? undefined : onDeployLater())}
      header={t("event_create.deploy_modal_header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDeployLater} disabled={deployStarting}>
              {t("event_create.deploy_modal_later")}
            </Button>
            <Button
              variant="primary"
              loading={deployStarting}
              onClick={onDeployNow}
              data-testid="deploy-prompt-now"
            >
              {t("event_create.deploy_modal_now")}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="info" header={t("event_create.deploy_modal_alert_header")}>
          {t("event_create.deploy_modal_alert_body")}
        </Alert>
      </SpaceBetween>
    </Modal>
  );
}
