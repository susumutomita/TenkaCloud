import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import { useCallback, useMemo, useState } from "react";
import { type NavigateFunction, useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { type DeploymentSummary, listAllDeployments } from "../api/deploy-client";
import {
  deploymentStackNameCell,
  deploymentStatusCell,
  deploymentTeamCell,
} from "../components/deployment-columns";
import type { AppConfig } from "../config";
import { usePollingList } from "../hooks/usePollingList";
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
      cell: deploymentTeamCell(navigate),
    },
    {
      id: "problemId",
      header: t("deployments.col_problem"),
      cell: (item) => <code>{item.problemId}</code>,
    },
    {
      id: "status",
      header: t("deployments.col_status"),
      cell: deploymentStatusCell,
    },
    {
      id: "namePrefix",
      header: t("deployments.col_stack_name"),
      cell: deploymentStackNameCell,
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
  const columnDefinitions = useMemo(() => buildColumnDefinitions(navigate, t), [navigate, t]);

  const fetcher = useMemo(
    () =>
      apiClient
        ? () =>
            listAllDeployments(apiClient, { limit: DEPLOYMENT_LIST_PAGE_SIZE }).then((r) => r.items)
        : null,
    [apiClient],
  );
  const { items, error, refresh } = usePollingList(
    fetcher,
    DEPLOYMENT_LIST_POLL_INTERVAL_MS,
    deploymentsChanged,
  );

  // reload button は polling と同じ refresh を spinner 付きで叩くだけ。
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const onReload = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await refresh();
    } finally {
      setManualRefreshing(false);
    }
  }, [refresh]);

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
          <Button onClick={onReload} loading={manualRefreshing}>
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
