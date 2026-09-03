import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useState } from "react";
import type { ApiClient } from "../../api/client";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import {
  getTeamCredentialStatus,
  TEAM_CREDENTIAL_PROVIDERS,
  type TeamCredentialProvider,
} from "../../api/team-credentials-client";
import { AWS_REGIONS } from "../../data/aws-regions";
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
  // Status keyed by internalSlug (not row index) so a resize/reorder can never
  // attach a check result to the wrong team.
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean | undefined>>({});
  const [checkingCredential, setCheckingCredential] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState<Record<string, boolean | undefined>>({});
  const providerMode = teamValidation.providerMode;
  // The credential-check API supports a fixed provider set; an unknown non-AWS
  // provider still renders the column but cannot offer the check button.
  const credentialProviders =
    providerMode?.kind === "nonAws"
      ? [providerMode.provider]
      : providerMode?.kind === "composite"
        ? providerMode.providers.filter((provider) => provider !== "aws")
        : [];
  const showAwsAccount =
    providerMode === undefined ||
    providerMode.kind === "aws" ||
    providerMode.kind === "mixed" ||
    (providerMode.kind === "composite" && providerMode.providers.includes("aws"));
  const checkableProvider = (provider: string): TeamCredentialProvider | undefined =>
    (TEAM_CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)
      ? (provider as TeamCredentialProvider)
      : undefined;
  const credentialStatusKey = (slug: string, provider: string) => `${slug}:${provider}`;
  const checkCredential = async (
    slug: string,
    provider: TeamCredentialProvider,
    teamSlug: string,
  ) => {
    /* v8 ignore next -- defensive: the button is disabled unless apiClient + a valid slug exist */
    if (!apiClient || !SLUG_RE.test(teamSlug)) return;
    const statusKey = credentialStatusKey(slug, provider);
    setCheckingCredential(statusKey);
    setCheckFailed((prev) => ({ ...prev, [statusKey]: undefined }));
    try {
      const status = await getTeamCredentialStatus(apiClient, provider, teamSlug);
      setCredentialStatus((prev) => ({ ...prev, [statusKey]: status.registered }));
    } catch {
      // Loud failure state (never mistaken for "unregistered").
      setCheckFailed((prev) => ({ ...prev, [statusKey]: true }));
    } finally {
      setCheckingCredential(null);
    }
  };
  /** The catalog's label when we have one; the raw code otherwise. */
  const regionLabel = (code: string) => AWS_REGIONS.find((r) => r.code === code)?.label ?? code;
  const columns: TableProps.ColumnDefinition<TeamTableItem>[] = [
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
  ];
  if (showAwsAccount) {
    columns.push({
      id: "account",
      header: t("event_create.col_aws_account"),
      cell: (tr) => {
        const selected = accountOptions.find((o) => o.value === tr.awsAccountId) ?? null;
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
              invalid={tr.awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(tr.awsAccountId)}
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
    });
  }
  if (showAwsAccount) {
    // [Issue #3173] Where this team's stacks go. Blank follows the problem's
    // region, which is what every event did before — one account and one region
    // for everybody, meeting that region's service limits first.
    columns.push({
      id: "region",
      header: t("event_create.col_team_region"),
      cell: (tr) => (
        <Select
          selectedOption={tr.region ? { value: tr.region, label: regionLabel(tr.region) } : null}
          options={[
            { value: "", label: t("event_create.team_region_inherit") },
            ...AWS_REGIONS.map((r) => ({ value: r.code, label: r.label })),
          ]}
          placeholder={t("event_create.team_region_inherit")}
          onChange={({ detail }) =>
            /* v8 ignore next */
            onUpdateTeamRow(tr.idx, { region: detail.selectedOption?.value ?? "" })
          }
          expandToViewport
        />
      ),
    });
  }
  for (const provider of credentialProviders) {
    columns.push({
      id: `nonAwsCredential-${provider}`,
      header: t("event_create.col_non_aws_credential", { provider }),
      cell: (tr) => {
        const providerForCheck = checkableProvider(provider);
        const statusKey = credentialStatusKey(tr.internalSlug, provider);
        return (
          <SpaceBetween size="xxs">
            <Input
              value={tr.nonAwsCredentialTeamSlug}
              placeholder={tr.internalSlug}
              invalid={!SLUG_RE.test(tr.nonAwsCredentialTeamSlug)}
              onChange={({ detail }) => {
                setCredentialStatus({});
                setCheckFailed({});
                onUpdateTeamRow(tr.idx, { nonAwsCredentialTeamSlug: detail.value });
              }}
            />
            <Button
              loading={checkingCredential === statusKey}
              disabled={
                !apiClient ||
                providerForCheck === undefined ||
                !SLUG_RE.test(tr.nonAwsCredentialTeamSlug)
              }
              onClick={() => {
                /* v8 ignore next -- defensive: the button is disabled in this state */
                if (providerForCheck === undefined) return;
                void checkCredential(
                  tr.internalSlug,
                  providerForCheck,
                  tr.nonAwsCredentialTeamSlug,
                );
              }}
            >
              {t("event_create.check_credential")}
            </Button>
            {checkFailed[statusKey] && (
              <Box variant="small" color="text-status-error">
                {t("event_create.check_credential_failed")}
              </Box>
            )}
            {credentialStatus[statusKey] !== undefined && (
              <Box
                variant="small"
                color={credentialStatus[statusKey] ? "text-status-success" : "text-status-error"}
              >
                {credentialStatus[statusKey]
                  ? t("event_create.credential_registered")
                  : t("event_create.credential_unregistered")}
              </Box>
            )}
          </SpaceBetween>
        );
      },
    });
  }

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
        <Table variant="embedded" items={[...teamTableItems]} columnDefinitions={columns} />
      )}
      {providerMode?.kind === "mixed" && (
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
