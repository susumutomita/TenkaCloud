import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import {
  type DeploymentStatus,
  type DeploymentSummary,
  listAllDeployments,
} from "../api/deploy-client";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 10_000;

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

/**
 * Tenant 内の deploy job 一覧。サイドバー「デプロイ履歴」から到達。
 * polling で 10 秒ごとに refresh して、進行中のジョブが COMPLETE / FAILED に変わるのを反映。
 */
export function DeploymentsPage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly DeploymentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient) return;
      if (showSpinner) setLoading(true);
      try {
        const res = await listAllDeployments(apiClient, { limit: 50 });
        setItems(res.items);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (showSpinner) setLoading(false);
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
          <Button onClick={() => fetchOnce({ showSpinner: true })} loading={loading}>
            再読み込み
          </Button>
        }
      >
        デプロイ履歴
      </Header>

      <Table
        items={items ? [...items] : []}
        loadingText="読み込み中"
        loading={loading && items === null}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            まだ deploy ジョブはありません。
          </Box>
        }
        columnDefinitions={[
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
              <StatusIndicator type={STATUS_TYPE[item.status]}>{item.status}</StatusIndicator>
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
        ]}
      />
    </SpaceBetween>
  );
}
