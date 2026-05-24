import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useMemo } from "react";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import { useT } from "../../i18n";

interface CompetitorAccountsTableProps {
  items: readonly CompetitorAccountSummary[];
  verifyInFlight: string | null;
  onVerify: (awsAccountId: string) => void;
  onRequestDelete: (item: CompetitorAccountSummary) => void;
}

export function CompetitorAccountsTable({
  items,
  verifyInFlight,
  onVerify,
  onRequestDelete,
}: CompetitorAccountsTableProps) {
  const t = useT();

  const columnDefinitions = useMemo<TableProps.ColumnDefinition<CompetitorAccountSummary>[]>(
    () => [
      {
        id: "awsAccountId",
        header: "AWS Account ID",
        cell: (item) => <code>{item.awsAccountId}</code>,
      },
      {
        id: "alias",
        header: t("competitor_accounts.col_alias"),
        cell: (item) =>
          item.alias ?? (
            <Box color="text-status-inactive">{t("competitor_accounts.alias_unset")}</Box>
          ),
      },
      {
        id: "region",
        header: "Region",
        cell: (item) => <code>{item.region}</code>,
      },
      {
        id: "competitorRoleName",
        header: t("competitor_accounts.col_role_name"),
        cell: (item) => <code>{item.competitorRoleName}</code>,
      },
      {
        id: "verified",
        header: t("competitor_accounts.col_status"),
        cell: (item) =>
          item.verified ? (
            <Badge color="green">Verified</Badge>
          ) : (
            <Badge color="red">Unverified</Badge>
          ),
      },
      {
        id: "actions",
        header: t("competitor_accounts.col_actions"),
        cell: (item) => (
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              loading={verifyInFlight === item.awsAccountId}
              disabled={verifyInFlight !== null}
              onClick={() => onVerify(item.awsAccountId)}
            >
              {item.verified
                ? t("competitor_accounts.verify_again")
                : t("competitor_accounts.verify")}
            </Button>
            <Button variant="link" onClick={() => onRequestDelete(item)}>
              {t("competitor_accounts.delete")}
            </Button>
          </SpaceBetween>
        ),
      },
    ],
    [onRequestDelete, onVerify, verifyInFlight, t],
  );

  return (
    <Table
      items={items}
      columnDefinitions={columnDefinitions}
      empty={
        <Box textAlign="center" color="inherit" padding="xxl">
          {t("competitor_accounts.table_empty")}
        </Box>
      }
    />
  );
}
