import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { type ReactNode, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client";
import { useCapacityOverview } from "../../hooks/useCapacityOverview";
import {
  buildCapacityRows,
  buildRunbookCommand,
  type CapacityHealth,
  type CapacityRowModel,
} from "../../lib/capacity-status";
import type { Translate } from "./tab-content-props";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 panel (高度操作 tab)。
 *
 * 運営が「消費 / プロビジョン / throttle」を見ながら Slice 1 の SSM runbook でキャパを
 * 上げ下げするための read-only ビュー。30 秒 polling (SSE/WS は導入しない方針) は
 * {@link useCapacityOverview} が担い、403 (TenantAdmin 以外) / 503 (未配線) / 501 (demo) は
 * polling を止めて情報 alert に切替える (エラーの赤 alert を出し続けない)。
 */

function healthIndicator(health: CapacityHealth, t: Translate): ReactNode {
  if (health === "throttling") {
    return <StatusIndicator type="error">{t("capacity.health_throttling")}</StatusIndicator>;
  }
  if (health === "hot") {
    return <StatusIndicator type="warning">{t("capacity.health_hot")}</StatusIndicator>;
  }
  return <StatusIndicator type="success">{t("capacity.health_ok")}</StatusIndicator>;
}

/** runbook コマンド例に使うテーブル: throttling > hot > 先頭 (対応が要る所を例示する)。 */
export function pickExampleTable(rows: readonly CapacityRowModel[]): string | null {
  const target =
    rows.find((r) => r.health === "throttling") ?? rows.find((r) => r.health === "hot") ?? rows[0];
  return target ? target.tableName : null;
}

const TERMINAL_MESSAGE_KEYS = {
  forbidden: "capacity.forbidden",
  unavailable: "capacity.unconfigured",
  unsupported: "capacity.demo_unsupported",
} as const;

export function CapacityPanel({ apiClient, t }: { apiClient: ApiClient | null; t: Translate }) {
  const { overview, error, terminalReason, refresh } = useCapacityOverview(apiClient);
  // 手動 refresh 中だけ button spinner を回す (30 秒 polling では回さない)。
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);

  const rows = useMemo(() => (overview ? buildCapacityRows(overview) : []), [overview]);
  const columnDefinitions = useMemo(
    () => [
      {
        id: "table",
        header: t("capacity.col_table"),
        cell: (row: CapacityRowModel) => (
          <SpaceBetween size="xxs">
            <Box variant="strong">{t(`capacity.role_${row.role}`)}</Box>
            <Box fontSize="body-s" color="text-status-inactive">
              {row.tableName}
            </Box>
          </SpaceBetween>
        ),
      },
      {
        id: "health",
        header: t("capacity.col_health"),
        cell: (row: CapacityRowModel) => healthIndicator(row.health, t),
      },
      {
        id: "provisioned",
        header: t("capacity.col_provisioned"),
        cell: (row: CapacityRowModel) => row.provisionedLabel,
      },
      {
        id: "consumedRead",
        header: t("capacity.col_consumed_read"),
        cell: (row: CapacityRowModel) => row.consumedReadLabel,
      },
      {
        id: "consumedWrite",
        header: t("capacity.col_consumed_write"),
        cell: (row: CapacityRowModel) => row.consumedWriteLabel,
      },
      {
        id: "throttles",
        header: t("capacity.col_throttles"),
        cell: (row: CapacityRowModel) =>
          row.throttleEvents > 0 ? (
            <StatusIndicator type="error">{row.throttleEvents}</StatusIndicator>
          ) : (
            <Box>0</Box>
          ),
      },
    ],
    [t],
  );

  const onManualRefresh = async () => {
    setManualRefreshInFlight(true);
    try {
      await refresh();
    } finally {
      setManualRefreshInFlight(false);
    }
  };

  const exampleTable = overview?.runbookDocumentName ? pickExampleTable(rows) : null;

  // Issue #2648: 純 SQL backend (DynamoDB 不使用) では容量監視は恒久的に非該当。空データや
  // エラー alert を見せるより panel 自体を出さないのが筋 (route が 404 → not_applicable)。
  // 全 hook を呼び切った後に return する (Rules of Hooks — early return で hook を飛ばさない)。
  if (terminalReason === "not_applicable") return null;

  return (
    <Container
      data-testid="capacity-panel"
      header={
        <Header
          variant="h3"
          description={
            overview
              ? t("capacity.description", {
                  windowMinutes: overview.windowMinutes,
                  ceiling: overview.ceiling,
                })
              : undefined
          }
          actions={
            <Button
              iconName="refresh"
              loading={manualRefreshInFlight}
              onClick={() => void onManualRefresh()}
              data-testid="capacity-refresh"
            >
              {t("capacity.refresh")}
            </Button>
          }
        >
          {t("capacity.header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {terminalReason ? (
          // 403 / 503 / 501 (demo) は再 poll しても変わらない terminal 状態: 赤エラーではなく
          // 情報 alert 1 枚に落として polling も止める (useCapacityOverview 側)。
          <Alert type="info" data-testid="capacity-terminal">
            {t(TERMINAL_MESSAGE_KEYS[terminalReason])}
          </Alert>
        ) : (
          <>
            {error && (
              <Alert type="error" data-testid="capacity-error">
                {t("capacity.load_failed", { message: error })}
              </Alert>
            )}
            <Table<CapacityRowModel>
              variant="embedded"
              items={rows}
              loading={!overview && !error}
              loadingText={t("capacity.loading")}
              columnDefinitions={columnDefinitions}
              empty={<Box textAlign="center">{t("capacity.empty")}</Box>}
            />
            {overview?.runbookDocumentName && (
              <Box data-testid="capacity-runbook-hint">
                <Box variant="strong">{t("capacity.runbook_hint")}</Box>
                <Box variant="code" fontSize="body-s">
                  {buildRunbookCommand(overview.runbookDocumentName, exampleTable ?? "<TableName>")}
                </Box>
                <Box fontSize="body-s" color="text-status-inactive">
                  {t("capacity.runbook_doc_pointer")}
                </Box>
              </Box>
            )}
          </>
        )}
      </SpaceBetween>
    </Container>
  );
}
