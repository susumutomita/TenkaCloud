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

const POLL_INTERVAL_MS = 10_000;

const EMPTY_ITEMS: readonly DeploymentSummary[] = [];

function buildColumnDefinitions(
  navigate: NavigateFunction,
): TableProps.ColumnDefinition<DeploymentSummary>[] {
  return [
    {
      id: "team",
      header: "チーム",
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
      header: "問題",
      cell: (item) => <code>{item.problemId}</code>,
    },
    {
      id: "status",
      header: "ステータス",
      cell: (item) => (
        <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
          {item.status}
        </StatusIndicator>
      ),
    },
    {
      id: "namePrefix",
      header: "Stack 名",
      cell: (item) => <code>{item.namePrefix}</code>,
    },
    {
      id: "createdAt",
      header: "作成",
      cell: (item) => item.createdAt,
    },
  ];
}

/** 行が変わっていれば true。同 jobId の status / updatedAt / displayTeamName を比較する。 */
function deploymentsChanged(
  prev: readonly DeploymentSummary[],
  next: readonly DeploymentSummary[],
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b) return true;
    if (
      a.jobId !== b.jobId ||
      a.status !== b.status ||
      a.updatedAt !== b.updatedAt ||
      a.displayTeamName !== b.displayTeamName
    ) {
      return true;
    }
  }
  return false;
}

export function DeploymentsPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly DeploymentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const columnDefinitions = useMemo(() => buildColumnDefinitions(navigate), [navigate]);

  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient) return;
      if (showSpinner) setManualRefreshing(true);
      try {
        const res = await listAllDeployments(apiClient, { limit: 50 });
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
      if (cancelled) return;
      await fetchOnce();
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce]);

  if (!items && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 一覧を取得中...
      </Box>
    );
  }

  if (error && !items) {
    return (
      <Alert type="error" header="一覧の取得に失敗しました">
        {error}
      </Alert>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="自テナントで起動した問題の deploy ジョブ一覧。各行を選ぶと詳細が見られます。"
        actions={
          <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
            再読み込み
          </Button>
        }
      >
        デプロイ履歴
      </Header>

      <Table
        items={items ?? EMPTY_ITEMS}
        columnDefinitions={columnDefinitions}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            まだ deploy ジョブはありません。
          </Box>
        }
      />
    </SpaceBetween>
  );
}
