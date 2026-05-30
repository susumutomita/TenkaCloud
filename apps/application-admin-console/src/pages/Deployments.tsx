import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type NavigateFunction, useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import {
  DEPLOYMENT_STATUS_INDICATOR,
  type DeploymentSummary,
  listAllDeployments,
} from "../api/deploy-client";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import {
  DEPLOYMENT_LIST_PAGE_SIZE,
  DEPLOYMENT_LIST_POLL_INTERVAL_MS,
  deploymentsChanged,
  EMPTY_DEPLOYMENT_ITEMS,
} from "../utils/deployments";

function buildColumnDefinitions(
  navigate: NavigateFunction,
  t: (key: string) => string,
): TableProps.ColumnDefinition<DeploymentSummary>[] {
  return [
    {
      id: "team",
      header: t("deployments.col_team"),
      cell: (item) => (
        <Link
          fontSize="body-m"
          href={`/deployments/${encodeURIComponent(item.jobId)}`}
          onFollow={(e) => {
            e.preventDefault();
            navigate(`/deployments/${encodeURIComponent(item.jobId)}`);
          }}
        >
          {item.displayTeamName ?? item.teamName}
        </Link>
      ),
    },
    {
      id: "problemId",
      header: t("deployments.col_problem"),
      cell: (item) => <code>{item.problemId}</code>,
    },
    {
      id: "status",
      header: t("deployments.col_status"),
      cell: (item) => (
        <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
          {item.status}
        </StatusIndicator>
      ),
    },
    {
      id: "namePrefix",
      header: t("deployments.col_stack_name"),
      cell: (item) => <code>{item.namePrefix}</code>,
    },
    {
      id: "createdAt",
      header: t("deployments.col_created_at"),
      cell: (item) => item.createdAt,
    },
  ];
}

export function DeploymentsPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const t = useT();
  const [items, setItems] = useState<readonly DeploymentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const columnDefinitions = useMemo(() => buildColumnDefinitions(navigate, t), [navigate, t]);

  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient) return;
      if (showSpinner) setManualRefreshing(true);
      try {
        const res = await listAllDeployments(apiClient, { limit: DEPLOYMENT_LIST_PAGE_SIZE });
        setItems((prev) => (prev && !deploymentsChanged(prev, res.items) ? prev : res.items));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (showSpinner) setManualRefreshing(false);
      }
    },
    [apiClient],
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // unmount 時に clearInterval するので interval 経由の再 tick は来ない。 cancelled=true を
      // 踏むのは teardown と既 queue の tick が競合する稀ケースのみ (= 防御的、不到達)。
      /* v8 ignore next */
      if (cancelled) return;
      await fetchOnce();
    };
    void tick();
    const interval = setInterval(tick, DEPLOYMENT_LIST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce]);

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("deployments.loading")}
      </Box>
    );
  }

  if (error && !items) {
    return (
      <Alert type="error" header={t("deployments.list_failed_header")}>
        {error}
      </Alert>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={t("deployments.description")}
        actions={
          <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
            {t("deployments.reload")}
          </Button>
        }
      >
        {t("deployments.header")}
      </Header>

      <Table
        // 上の loading / error guard を抜けた時点で items は必ず non-null。 ?? は型 narrowing 用の
        // 安全網で右辺は不到達。
        /* v8 ignore next */
        items={items ?? EMPTY_DEPLOYMENT_ITEMS}
        columnDefinitions={columnDefinitions}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            {t("deployments.empty")}
          </Box>
        }
      />
    </SpaceBetween>
  );
}
