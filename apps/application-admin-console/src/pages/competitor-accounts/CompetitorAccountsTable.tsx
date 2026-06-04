import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { EmptyState } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import type { CompetitorAccountSummary } from "../../api/competitor-accounts-client";
import { useT } from "../../i18n";

interface CompetitorAccountsTableProps {
  items: readonly CompetitorAccountSummary[];
  verifyInFlight: string | null;
  onVerify: (awsAccountId: string) => void;
  onRequestDelete: (item: CompetitorAccountSummary) => void;
  /** Empty-state primary action — opens the add-account modal (same as the header button). */
  onAdd: () => void;
}

export function CompetitorAccountsTable({
  items,
  verifyInFlight,
  onVerify,
  onRequestDelete,
  onAdd,
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
        // Issue #1362: Badge から StatusIndicator に変更。 built-in icon (= ✓ / ✗) と
        // 色を Cloudscape の semantic types で共有し、 「状態 badge は icon + 色 + 位置」 で
        // 強調する Qiita 原則に揃える。
        cell: (item) =>
          item.verified ? (
            <StatusIndicator type="success">Verified</StatusIndicator>
          ) : (
            <StatusIndicator type="error">Unverified</StatusIndicator>
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
      // Issue #1362 / empty-state UX: 空表示は説明 + 実際に押せる primary action を出す
      // (= 装飾 icon ではなく、 ここから直接 account を追加できる)。
      empty={
        <EmptyState
          headline={t("competitor_accounts.table_empty")}
          primaryAction={{ label: t("competitor_accounts.add_button"), onClick: onAdd }}
        />
      }
    />
  );
}
