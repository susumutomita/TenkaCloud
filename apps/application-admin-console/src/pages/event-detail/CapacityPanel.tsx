import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { type ReactNode, useCallback, useState } from "react";
import { type CapacityOverview, getCapacityOverview } from "../../api/capacity-client";
import type { ApiClient } from "../../api/client";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "../../constants/polling";
import {
  buildCapacityRows,
  buildRunbookCommand,
  type CapacityHealth,
  type CapacityRowModel,
} from "../../lib/capacity-status";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 panel (高度操作 tab)。
 *
 * 運営が「消費 / プロビジョン / throttle」を見ながら Slice 1 の SSM runbook でキャパを
 * 上げ下げするための read-only ビュー。30 秒 polling (SSE/WS は導入しない方針)。
 * backend は TenantAdmin 限定 (`GET /admin/capacity`) — 他 role では 403 が error 表示になる。
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

export function CapacityPanel({ apiClient, t }: { apiClient: ApiClient | null; t: Translate }) {
  const [overview, setOverview] = useState<CapacityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiClient) return;
    setRefreshing(true);
    try {
      setOverview(await getCapacityOverview(apiClient));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [apiClient]);

  usePolling(refresh, DEPLOYMENT_POLL_INTERVAL_MS);

  const rows = overview ? buildCapacityRows(overview) : [];

  return (
    <Container
      data-testid="capacity-panel"
      header={
        <Header
          variant="h3"
          description={t("capacity.description", {
            windowMinutes: overview?.windowMinutes ?? 30,
            ceiling: overview?.ceiling ?? 200,
          })}
          actions={
            <Button
              iconName="refresh"
              loading={refreshing}
              onClick={() => void refresh()}
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
        {error && (
          <Alert type="error" data-testid="capacity-error">
            {t("capacity.load_failed", { message: error })}
          </Alert>
        )}
        <Table<CapacityRowModel>
          variant="embedded"
          items={[...rows]}
          loading={!overview && !error}
          loadingText={t("capacity.loading")}
          columnDefinitions={[
            {
              id: "table",
              header: t("capacity.col_table"),
              cell: (row) => (
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
              cell: (row) => healthIndicator(row.health, t),
            },
            {
              id: "provisioned",
              header: t("capacity.col_provisioned"),
              cell: (row) => row.provisionedLabel,
            },
            {
              id: "consumedRead",
              header: t("capacity.col_consumed_read"),
              cell: (row) => row.consumedReadLabel,
            },
            {
              id: "consumedWrite",
              header: t("capacity.col_consumed_write"),
              cell: (row) => row.consumedWriteLabel,
            },
            {
              id: "throttles",
              header: t("capacity.col_throttles"),
              cell: (row) =>
                row.throttleEvents > 0 ? (
                  <StatusIndicator type="error">{row.throttleEvents}</StatusIndicator>
                ) : (
                  <Box>0</Box>
                ),
            },
          ]}
          empty={<Box textAlign="center">{t("capacity.empty")}</Box>}
        />
        {overview?.runbookDocumentName && (
          <Box data-testid="capacity-runbook-hint">
            <Box variant="strong">{t("capacity.runbook_hint")}</Box>
            <Box variant="code" fontSize="body-s">
              {buildRunbookCommand(
                overview.runbookDocumentName,
                rows[0]?.tableName ?? "<TableName>",
              )}
            </Box>
            <Box fontSize="body-s" color="text-status-inactive">
              {t("capacity.runbook_doc_pointer")}
            </Box>
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
