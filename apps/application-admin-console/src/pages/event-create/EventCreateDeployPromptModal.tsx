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
 *
 * [Issue #2649] 作成 response の平文 teamLoginKey をこの modal で一度だけ配布可能な形で出す。
 * 純 SQL backend (turso|sql) は key を hash でしか保存しないため EventDetail のチーム表から
 * 復元できず、 ここで捕まえ損ねると再 deploy でしか再発行できない。DynamoDB backend でも同じ
 * 「生成時に配布」 UX に揃える (backend 分岐なし = INVARIANT_APP_CODE_IS_UNMODIFIED)。
 */
export interface DeployPromptTeamKey {
  readonly internalSlug: string;
  readonly teamLoginKey: string;
}

export interface EventCreateDeployPromptModalProps {
  visible: boolean;
  canMutateTenant: boolean;
  deployStarting: boolean;
  /**
   * [#2563 v1] Bulk deploy rides the AWS/CFn pipeline only; a non-AWS
   * single-provider event hides "Deploy now" and points the operator at the
   * per-team single-deploy path instead of enqueueing a bulk run that the
   * backend would refuse.
   */
  bulkDeploySupported?: boolean;
  /**
   * [#2649] 作成直後の team ごとの平文 teamLoginKey。plaintext がここでしか出ない (特に SQL
   * backend) ので、 operator が今コピーして配布するための一覧を出す。空/未指定なら section を出さない。
   */
  teamKeys?: readonly DeployPromptTeamKey[];
  onDeployNow: () => void;
  onDeployLater: () => void;
}

export function EventCreateDeployPromptModal({
  visible,
  canMutateTenant,
  deployStarting,
  bulkDeploySupported = true,
  teamKeys,
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
            {bulkDeploySupported && (
              <Button
                variant="primary"
                loading={deployStarting}
                disabled={!canMutateTenant}
                onClick={onDeployNow}
                data-testid="deploy-prompt-now"
              >
                {t("event_create.deploy_modal_now")}
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Alert type="info" header={t("event_create.deploy_modal_alert_header")}>
          {bulkDeploySupported
            ? t("event_create.deploy_modal_alert_body")
            : t("event_create.deploy_modal_alert_body_non_aws")}
        </Alert>
        {teamKeys && teamKeys.length > 0 && (
          <Alert
            type="warning"
            header={t("event_create.deploy_modal_keys_header")}
            data-testid="deploy-prompt-keys"
          >
            <SpaceBetween size="s">
              <Box>{t("event_create.deploy_modal_keys_warning")}</Box>
              {teamKeys.map((team) => (
                <SpaceBetween
                  key={team.internalSlug}
                  direction="horizontal"
                  size="xs"
                  alignItems="center"
                >
                  <Box variant="awsui-key-label">{team.internalSlug}</Box>
                  <Box variant="code" fontSize="body-s">
                    {team.teamLoginKey}
                  </Box>
                  <Button
                    iconName="copy"
                    variant="inline-icon"
                    ariaLabel={t("event_create.deploy_modal_keys_copy_aria", {
                      slug: team.internalSlug,
                    })}
                    onClick={() => void navigator.clipboard?.writeText(team.teamLoginKey)}
                  />
                </SpaceBetween>
              ))}
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
