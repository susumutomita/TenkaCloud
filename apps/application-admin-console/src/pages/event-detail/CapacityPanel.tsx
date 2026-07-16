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
import { CapacityScaleModal } from "./CapacityScaleModal";
import type { Translate } from "./tab-content-props";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 panel (高度操作 tab)。
 *
 * 運営が「消費 / プロビジョン / throttle」を見ながら Slice 1 の SSM runbook でキャパを
 * 上げ下げするためのビュー。30 秒 polling (SSE/WS は導入しない方針) は
 * {@link useCapacityOverview} が担い、403 (TenantAdmin 以外) / 503 (未配線) / 501 (demo) は
 * polling を止めて情報 alert に切替える (エラーの赤 alert を出し続けない)。
 *
 * Issue #2680: runbook が配線された stack では「キャパシティを変更」action から
 * {@link CapacityScaleModal} で同じ runbook を API 経由で起動できる (CLI 実行例の表示は継続)。
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
  // Issue #2680: 「キャパシティを変更」modal + 受理後の dismissible flash。
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [scaleFlash, setScaleFlash] = useState<string | null>(null);

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

  // Issue #2680: 変更 action は applicable + runbook 配線済みの stack だけに出す (turso /
  // 未配線 stack は従来どおり read-only)。apiClient を先頭で見るのは型 narrowing のため
  // (このブロックが truthy なら modal に non-null の client / overview を渡せる)。
  const scaleReady =
    apiClient && overview?.applicable && overview.runbookDocumentName
      ? { apiClient, overview }
      : null;

  // Hide the entire DynamoDB-specific surface until capability resolution completes. Pure SQL
  // backends remain hidden after their explicit non-applicable response and stop polling in the
  // hook, so operators never see a misleading empty DynamoDB panel.
  if ((!overview && !error && !terminalReason) || overview?.applicable === false) return null;

  return (
    <>
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
              <SpaceBetween direction="horizontal" size="xs">
                {scaleReady && (
                  <Button
                    onClick={() => setScaleModalVisible(true)}
                    data-testid="capacity-scale-open"
                  >
                    {t("capacity.scale_action")}
                  </Button>
                )}
                <Button
                  iconName="refresh"
                  loading={manualRefreshInFlight}
                  onClick={() => void onManualRefresh()}
                  data-testid="capacity-refresh"
                >
                  {t("capacity.refresh")}
                </Button>
              </SpaceBetween>
            }
          >
            {t("capacity.header")}
          </Header>
        }
      >
        <SpaceBetween size="m">
          {scaleFlash && (
            // 受理は 202 (UpdateTable は非同期)。反映は 30 秒 polling の表の値で確認する。
            <Alert
              type="success"
              dismissible
              onDismiss={() => setScaleFlash(null)}
              data-testid="capacity-scale-accepted"
            >
              {scaleFlash}
            </Alert>
          )}
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
                  {t("capacity.load_failed")}
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
                    {buildRunbookCommand(
                      overview.runbookDocumentName,
                      exampleTable ?? "<TableName>",
                    )}
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
      {scaleReady && scaleModalVisible && (
        <CapacityScaleModal
          apiClient={scaleReady.apiClient}
          overview={scaleReady.overview}
          t={t}
          onClose={() => setScaleModalVisible(false)}
          onAccepted={(accepted) => {
            setScaleModalVisible(false);
            setScaleFlash(t("capacity.scale_accepted", { executionId: accepted.executionId }));
          }}
        />
      )}
    </>
  );
}
