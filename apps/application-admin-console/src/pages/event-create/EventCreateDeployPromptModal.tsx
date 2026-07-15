import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { CreateEventResponse } from "../../api/events-client";
import { useT } from "../../i18n";
import { buildInviteLink } from "../../lib/invite-link";

/**
 * Issue #1067: Event 作成成功後に operator へ deploy の必要性を明示する modal。
 *
 * 旧挙動 (= 即 EventDetail に navigate) では「Deploy が必要」 と気付かないまま
 * participant 側で問題が見えない silent failure が頻発していた。 modal で
 * 「いま deploy する」 / 「あとで」 の二択を明示する。
 */
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
  /** Plaintext values from POST /events. They exist only while this modal is open. */
  teams: CreateEventResponse["teams"];
  readonly participantPortalUrl?: string;
  onDeployNow: () => void;
  onDeployLater: () => void;
}

export function EventCreateDeployPromptModal({
  visible,
  canMutateTenant,
  deployStarting,
  bulkDeploySupported = true,
  teams,
  participantPortalUrl,
  onDeployNow,
  onDeployLater,
}: EventCreateDeployPromptModalProps) {
  const t = useT();
  const copyAll = () =>
    navigator.clipboard?.writeText(
      teams.map((team) => `${team.internalSlug}\t${team.teamLoginKey}`).join("\n"),
    );
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
        <Alert type="warning" header={t("event_create.login_keys_header")}>
          {t("event_create.login_keys_body")}
        </Alert>
        <Table
          variant="embedded"
          items={[...teams]}
          columnDefinitions={[
            {
              id: "team",
              header: t("event_create.login_keys_team"),
              cell: (team) => <code>{team.internalSlug}</code>,
            },
            {
              id: "key",
              header: "teamLoginKey",
              cell: (team) => <Box variant="code">{team.teamLoginKey}</Box>,
            },
            ...(participantPortalUrl
              ? [
                  {
                    id: "invite",
                    header: t("event_create.login_keys_invite"),
                    cell: (team: CreateEventResponse["teams"][number]) => (
                      <Button
                        iconName="share"
                        onClick={() =>
                          void navigator.clipboard?.writeText(
                            buildInviteLink(participantPortalUrl, team.teamLoginKey),
                          )
                        }
                      >
                        {t("event_create.login_keys_copy_invite", {
                          slug: team.internalSlug,
                        })}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          empty={<Box>{t("event_create.login_keys_empty")}</Box>}
        />
        <Box float="right">
          <Button iconName="copy" onClick={() => void copyAll()} disabled={teams.length === 0}>
            {t("event_create.login_keys_copy_all")}
          </Button>
        </Box>
        <Alert type="info" header={t("event_create.deploy_modal_alert_header")}>
          {bulkDeploySupported
            ? t("event_create.deploy_modal_alert_body")
            : t("event_create.deploy_modal_alert_body_non_aws")}
        </Alert>
      </SpaceBetween>
    </Modal>
  );
}
