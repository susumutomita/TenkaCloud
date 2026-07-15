import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import {
  type EventDetail,
  type RotateTeamLoginKeyResponse,
  rotateTeamLoginKey,
  type TeamSummary,
} from "../../api/events-client";
import { TeamLoginKeyRotationModal } from "./TeamLoginKeyRotationModal";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function EventTeamsPanel({
  detail,
  apiClient,
  canMutateTenant = false,
  t,
  onRefresh,
}: {
  readonly apiClient?: ApiClient | null;
  readonly canMutateTenant?: boolean;
  readonly detail: EventDetail;
  readonly onRefresh?: () => void;
  readonly t: Translate;
}) {
  const [rotationTeam, setRotationTeam] = useState<TeamSummary | null>(null);
  const [rotationResult, setRotationResult] = useState<RotateTeamLoginKeyResponse | null>(null);
  const [rotationError, setRotationError] = useState<string | null>(null);
  const [rotationInFlight, setRotationInFlight] = useState(false);
  const [rotatedKeys, setRotatedKeys] = useState<Readonly<Record<string, string>>>({});

  const closeRotation = () => {
    setRotationTeam(null);
    setRotationResult(null);
    setRotationError(null);
  };

  const confirmRotation = async () => {
    /* v8 ignore next -- button is rendered only with both values present */
    if (!apiClient || !rotationTeam) return;
    setRotationInFlight(true);
    setRotationError(null);
    try {
      const result = await rotateTeamLoginKey(apiClient, detail.eventId, rotationTeam.teamId);
      setRotationResult(result);
      setRotatedKeys((current) => ({ ...current, [result.teamId]: result.teamLoginKey }));
      onRefresh?.();
    } catch (error) {
      setRotationError(toErrorMessage(error));
    } finally {
      setRotationInFlight(false);
    }
  };

  return (
    <>
      <ExpandableSection
        variant="container"
        defaultExpanded={
          detail.status === "DRAFT" || detail.status === "DEPLOYING" || detail.status === "READY"
        }
        headerText={t("event_detail.teams_header", { count: detail.teams.length })}
        headerDescription={t("event_detail.teams_description")}
      >
        <Table
          variant="embedded"
          items={[...detail.teams]}
          columnDefinitions={[
            {
              id: "slug",
              header: t("event_detail.teams_col_slug"),
              cell: (tr) => <code>{tr.internalSlug}</code>,
            },
            {
              id: "displayName",
              header: t("event_detail.teams_col_display_name"),
              cell: (tr) =>
                tr.displayName ?? (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.teams_col_display_name_unset")}
                  </Box>
                ),
            },
            {
              id: "account",
              header: t("event_detail.teams_col_account"),
              cell: (tr) =>
                tr.awsAccountId ? (
                  <code>{tr.awsAccountId}</code>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.teams_col_account_legacy")}
                  </Box>
                ),
            },
            {
              id: "loginKey",
              header: t("event_detail.teams_col_login_key"),
              cell: (team) => {
                const loginKey = rotatedKeys[team.teamId] ?? team.teamLoginKey;
                return canMutateTenant && loginKey ? (
                  <CopyToClipboard
                    textToCopy={loginKey}
                    copyButtonText={t("event_detail.teams_col_login_key_copy")}
                    copyButtonAriaLabel={t("event_detail.teams_col_login_key_copy")}
                    copySuccessText={t("event_detail.teams_col_login_key_copied")}
                    copyErrorText={t("event_detail.teams_col_login_key_copy_failed")}
                    variant="inline"
                  />
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.teams_col_login_key_unavailable")}
                  </Box>
                );
              },
            },
            {
              id: "access",
              header: t("event_detail.teams_col_access"),
              cell: (team) =>
                canMutateTenant && apiClient ? (
                  <Button
                    onClick={() => {
                      setRotationTeam(team);
                      setRotationResult(null);
                      setRotationError(null);
                    }}
                  >
                    {t("event_detail.rotate_key_action")}
                  </Button>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.rotate_key_admin_only")}
                  </Box>
                ),
            },
          ]}
          empty={<Box>{t("event_detail.teams_empty")}</Box>}
        />
      </ExpandableSection>
      <TeamLoginKeyRotationModal
        error={rotationError}
        inFlight={rotationInFlight}
        onClose={closeRotation}
        onConfirm={() => void confirmRotation()}
        result={rotationResult}
        team={rotationTeam}
        t={t}
      />
    </>
  );
}
