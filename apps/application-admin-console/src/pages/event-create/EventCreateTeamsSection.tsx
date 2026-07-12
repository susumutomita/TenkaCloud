import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import {
  getTeamCredentialStatus,
  type TeamCredentialProvider,
} from "../../api/team-credentials-client";
import { useT } from "../../i18n";
import {
  ACCOUNT_ID_RE,
  formatVerifiedAccountSummary,
  SLUG_RE,
  type TeamRow,
  type TeamTableItem,
  type TeamValidation,
} from "./helpers";

/**
 * Teams section: 各 team の internalSlug + AWS Account ID 入力。
 *
 * - account 列は verified=true な CompetitorAccount のみ選択肢に出る drop-down
 *   (Phase 2.2 Issue #459)
 * - 0 件のときは disabled + helper text、 重複 slug は table 下に error 表示
 */
export interface EventCreateTeamsSectionProps {
  teamTableItems: readonly TeamTableItem[];
  teamCount: number;
  teamValidation: TeamValidation;
  accountOptions: readonly SelectProps.Option[];
  accountById: ReadonlyMap<string, CompetitorAccountSummary>;
  noVerifiedAccounts: boolean;
  apiClient?: ApiClient | null;
  onUpdateTeamRow: (idx: number, patch: Partial<TeamRow>) => void;
}

export function EventCreateTeamsSection({
  teamTableItems,
  teamCount,
  teamValidation,
  accountOptions,
  accountById,
  noVerifiedAccounts,
  apiClient,
  onUpdateTeamRow,
}: EventCreateTeamsSectionProps) {
  const t = useT();
  const [credentialStatus, setCredentialStatus] = useState<Record<number, boolean | undefined>>({});
  const [checkingCredential, setCheckingCredential] = useState<number | null>(null);
  const checkCredential = async (
    idx: number,
    provider: TeamCredentialProvider,
    teamSlug: string,
  ) => {
    if (!apiClient || !SLUG_RE.test(teamSlug)) return;
    setCheckingCredential(idx);
    try {
      const status = await getTeamCredentialStatus(apiClient, provider, teamSlug);
      setCredentialStatus((prev) => ({ ...prev, [idx]: status.registered }));
    } finally {
      setCheckingCredential(null);
    }
  };
  return (
    <Container
      header={
        <Header variant="h2" description={t("event_create.teams_description")}>
          {t("event_create.teams_header", { count: teamCount })}
        </Header>
      }
    >
      {teamCount === 0 ? (
        <Box variant="small" color="text-status-inactive">
          {t("event_create.teams_empty")}
        </Box>
      ) : (
        <Table
          variant="embedded"
          items={[...teamTableItems]}
          columnDefinitions={[
            {
              id: "slug",
              header: t("event_create.col_internal_slug"),
              cell: (tr) => (
                <Input
                  value={tr.internalSlug}
                  placeholder="team-1"
                  invalid={!SLUG_RE.test(tr.internalSlug)}
                  onChange={({ detail }) => onUpdateTeamRow(tr.idx, { internalSlug: detail.value })}
                />
              ),
            },
            teamValidation.providerMode?.kind === "nonAws"
              ? {
                  id: "nonAwsCredential",
                  header: t("event_create.col_non_aws_credential", {
                    provider: teamValidation.providerMode.provider,
                  }),
                  cell: (tr) => (
                    <SpaceBetween size="xxs">
                      <Input
                        value={tr.nonAwsCredentialTeamSlug ?? ""}
                        placeholder={tr.internalSlug}
                        invalid={!SLUG_RE.test(tr.nonAwsCredentialTeamSlug ?? "")}
                        onChange={({ detail }) => {
                          setCredentialStatus((prev) => ({ ...prev, [tr.idx]: undefined }));
                          onUpdateTeamRow(tr.idx, { nonAwsCredentialTeamSlug: detail.value });
                        }}
                      />
                      <Button
                        loading={checkingCredential === tr.idx}
                        disabled={!apiClient || !SLUG_RE.test(tr.nonAwsCredentialTeamSlug ?? "")}
                        onClick={() =>
                          void checkCredential(
                            tr.idx,
                            teamValidation.providerMode?.kind === "nonAws"
                              ? (teamValidation.providerMode.provider as TeamCredentialProvider)
                              : "gcp",
                            tr.nonAwsCredentialTeamSlug ?? tr.internalSlug,
                          )
                        }
                      >
                        {t("event_create.check_credential")}
                      </Button>
                      {credentialStatus[tr.idx] !== undefined && (
                        <Box
                          variant="small"
                          color={
                            credentialStatus[tr.idx] ? "text-status-success" : "text-status-error"
                          }
                        >
                          {credentialStatus[tr.idx]
                            ? t("event_create.credential_registered")
                            : t("event_create.credential_unregistered")}
                        </Box>
                      )}
                    </SpaceBetween>
                  ),
                }
              : {
                  id: "account",
                  header: t("event_create.col_aws_account"),
                  cell: (tr) => {
                    const selected =
                      accountOptions.find((o) => o.value === tr.awsAccountId) ?? null;
                    const selectedAccount = accountById.get(tr.awsAccountId);
                    return (
                      <SpaceBetween size="xxs">
                        <Select
                          selectedOption={selected}
                          options={[...accountOptions]}
                          placeholder={
                            noVerifiedAccounts
                              ? t("event_create.no_verified_helper")
                              : t("event_create.select_verified_placeholder")
                          }
                          disabled={accountOptions.length === 0}
                          empty={t("event_create.select_empty_message")}
                          onChange={({ detail }) =>
                            onUpdateTeamRow(tr.idx, {
                              /* v8 ignore next */
                              awsAccountId: detail.selectedOption?.value ?? "",
                            })
                          }
                          invalid={
                            tr.awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(tr.awsAccountId)
                          }
                          expandToViewport
                          filteringType="auto"
                        />
                        {selectedAccount && (
                          <Box variant="small" color="text-status-inactive">
                            <span title={formatVerifiedAccountSummary(selectedAccount)}>
                              {formatVerifiedAccountSummary(selectedAccount)}
                            </span>
                          </Box>
                        )}
                        {noVerifiedAccounts && (
                          <Box variant="small" color="text-status-inactive">
                            {t("event_create.no_verified_helper")}
                          </Box>
                        )}
                      </SpaceBetween>
                    );
                  },
                },
          ]}
        />
      )}
      {teamValidation.providerMode?.kind === "mixed" && (
        <Box variant="small" color="text-status-error" padding={{ top: "xs" }}>
          {t("event_create.mixed_provider_error")}
        </Box>
      )}
      {teamValidation.hasDuplicateSlug && (
        <Box variant="small" color="text-status-error" padding={{ top: "xs" }}>
          {t("event_create.duplicate_slug_error")}
        </Box>
      )}
    </Container>
  );
}
