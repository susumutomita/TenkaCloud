import Box from "@cloudscape-design/components/box";
import Icon from "@cloudscape-design/components/icon";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { AuditItem } from "../api/audit-client";
import { useLang, useT } from "../i18n";
import { formatRelativeTime } from "../lib/format";

function outcomeIndicator(outcome: string) {
  if (outcome === "success") return <StatusIndicator type="success">success</StatusIndicator>;
  if (outcome === "forbidden") return <StatusIndicator type="error">forbidden</StatusIndicator>;
  if (outcome === "not_found") return <StatusIndicator type="warning">not_found</StatusIndicator>;
  if (outcome === "conflict") return <StatusIndicator type="warning">conflict</StatusIndicator>;
  if (outcome === "error") return <StatusIndicator type="error">error</StatusIndicator>;
  return <span>{outcome}</span>;
}

/**
 * SystemAdmin 監査ログの結果テーブル。 `AuditLogPage` から切り出し、 Table / 時刻フォーマット /
 * outcome バッジ (StatusIndicator) 依存をこの module に閉じ込めた (= ページの高結合を解消)。
 */
export function AuditLogTable({
  items,
  loading,
}: {
  items: readonly AuditItem[];
  loading: boolean;
}) {
  const t = useT();
  const lang = useLang();
  return (
    <Table
      loading={loading}
      loadingText={t("audit_log.loading_text")}
      items={[...items]}
      columnDefinitions={[
        {
          id: "occurredAt",
          header: t("audit_log.col_occurred_at"),
          // Issue #1362: ISO 生値ではなく 「N 分前」 表示 + hover で絶対時刻 tooltip。
          cell: (i) => <span title={i.occurredAt}>{formatRelativeTime(i.occurredAt, lang)}</span>,
        },
        {
          id: "actor",
          header: t("audit_log.col_actor"),
          cell: (i) => i.actorUsername ?? i.actor,
        },
        {
          id: "action",
          header: t("audit_log.col_action"),
          cell: (i) => i.action,
        },
        {
          id: "outcome",
          header: t("audit_log.col_result"),
          cell: (i) => outcomeIndicator(i.outcome),
        },
        {
          id: "target",
          header: t("audit_log.col_target"),
          cell: (i) => i.target ?? "-",
        },
        {
          id: "tenantId",
          header: t("audit_log.col_tenant"),
          cell: (i) => i.tenantId,
        },
        {
          id: "ipAddress",
          header: t("audit_log.col_ip"),
          cell: (i) => i.ipAddress ?? "-",
        },
      ]}
      empty={
        // Issue #1362: アイコン + 強調 + 行動誘導の 3 段で empty state を friendly に。
        <Box textAlign="center" padding="l">
          <SpaceBetween size="xs">
            <Box variant="strong" color="text-status-inactive">
              <Icon name="file" size="big" variant="subtle" /> {t("audit_log.empty_header")}
            </Box>
            <Box color="text-body-secondary">{t("audit_log.empty_hint_filter")}</Box>
          </SpaceBetween>
        </Box>
      }
    />
  );
}
