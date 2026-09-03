import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import type { CoordinationCapacityWarning, CreateEventResponse } from "../../api/events-client";
import { LiteDrillCheckpointAlert } from "../../components/LiteDrillCheckpointAlert";
import { OneTimeSecretCopyButton } from "../../components/OneTimeSecretCopyButton";
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
  /**
   * Issue #2696: Lite mode のオンボーディングドリル 「初回イベント作成」 チェックポイント
   * コード。 caller (= EventCreatePage) が Lite 判定込みで解決し、 非 Lite では undefined。
   */
  readonly liteDrillCheckpointCode?: string;
  /**
   * [Issue #3169] Advisory notes from creation, today: a coordination problem
   * measured against this event's team count on the selected backend.
   *
   * The two verdicts are rendered apart. `"over"` is an error because it is not
   * a caution — the deploy this modal is offering will be refused, and the
   * operator's options are fewer teams or a different backend, both cheaper to
   * act on here than after they leave this screen. `"tight"` is a warning: that
   * event deploys today, and telling its operator it will be refused would be
   * false.
   */
  readonly capacityWarnings?: readonly CoordinationCapacityWarning[];
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
  liteDrillCheckpointCode,
  capacityWarnings = [],
  onDeployNow,
  onDeployLater,
}: EventCreateDeployPromptModalProps) {
  const t = useT();
  const [copyPending, setCopyPending] = useState(false);
  const busy = deployStarting || copyPending;
  const allLoginKeys = teams.map((team) => `${team.internalSlug}\t${team.teamLoginKey}`).join("\n");
  const capacityRefusals = capacityWarnings.filter((warning) => warning.kind === "over");
  const capacityTight = capacityWarnings.filter((warning) => warning.kind === "tight");

  return (
    <Modal
      visible={visible}
      onDismiss={busy ? undefined : onDeployLater}
      header={t("event_create.deploy_modal_header")}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={onDeployLater} disabled={busy}>
              {t("event_create.deploy_modal_later")}
            </Button>
            {bulkDeploySupported && (
              <Button
                variant="primary"
                loading={deployStarting}
                disabled={!canMutateTenant || copyPending}
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
              header: t("event_create.login_keys_key"),
              cell: (team) => <Box variant="code">{team.teamLoginKey}</Box>,
            },
            ...(participantPortalUrl
              ? [
                  {
                    id: "invite",
                    header: t("event_create.login_keys_invite"),
                    cell: (team: CreateEventResponse["teams"][number]) => (
                      <OneTimeSecretCopyButton
                        textToCopy={buildInviteLink(participantPortalUrl, team.teamLoginKey)}
                        copyLabel={t("event_create.login_keys_copy_invite", {
                          slug: team.internalSlug,
                        })}
                        copyingLabel={t("event_create.login_keys_copying")}
                        copiedLabel={t("event_create.login_keys_copied")}
                        failedLabel={t("event_create.login_keys_copy_failed")}
                        disabled={busy}
                        onPendingChange={setCopyPending}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          empty={<Box>{t("event_create.login_keys_empty")}</Box>}
        />
        <Box float="right">
          <OneTimeSecretCopyButton
            textToCopy={allLoginKeys}
            copyLabel={t("event_create.login_keys_copy_all")}
            copyingLabel={t("event_create.login_keys_copying")}
            copiedLabel={t("event_create.login_keys_copied")}
            failedLabel={t("event_create.login_keys_copy_failed")}
            disabled={busy || teams.length === 0}
            onPendingChange={setCopyPending}
          />
        </Box>
        <Alert type="info" header={t("event_create.deploy_modal_alert_header")}>
          {bulkDeploySupported
            ? t("event_create.deploy_modal_alert_body")
            : t("event_create.deploy_modal_alert_body_non_aws")}
        </Alert>
        {capacityRefusals.length > 0 && (
          <Alert type="error" header={t("event_create.capacity_warning_header")}>
            <ul>
              {capacityRefusals.map((warning) => (
                <li key={warning.message}>{warning.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        {capacityTight.length > 0 && (
          <Alert type="warning" header={t("event_create.capacity_tight_header")}>
            <ul>
              {capacityTight.map((warning) => (
                <li key={warning.message}>{warning.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        {liteDrillCheckpointCode && <LiteDrillCheckpointAlert code={liteDrillCheckpointCode} />}
      </SpaceBetween>
    </Modal>
  );
}
