import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useDeployApiClient } from "../api/client";
import {
  type DeploymentStatus,
  type DeploymentSummary,
  getDeployment,
  JOB_ID_RE,
  parseStackOutputs,
  TERMINAL_STATUSES,
} from "../api/deploy-client";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 5_000;

const STATUS_TYPE: Record<DeploymentStatus, StatusIndicatorProps.Type> = {
  PENDING: "pending",
  IN_PROGRESS: "in-progress",
  COMPLETE: "success",
  FAILED: "error",
  DELETING: "in-progress",
  DELETED: "stopped",
};

export function DeploymentDetailPage({ config }: { config: AppConfig }) {
  const { jobId } = useParams<{ jobId: string }>();
  const apiClient = useDeployApiClient(config);
  const [item, setItem] = useState<DeploymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const stopPollingRef = useRef(false);

  // showSpinner=true は手動再読み込みボタンからの呼び出し時のみ。auto polling は
  // 5 秒ごとに spinner を点滅させずバックグラウンド更新する。
  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
      if (showSpinner) setManualRefreshing(true);
      try {
        const fetched = await getDeployment(apiClient, jobId);
        setItem(fetched);
        setError(null);
        if (TERMINAL_STATUSES.has(fetched.status)) stopPollingRef.current = true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (showSpinner) setManualRefreshing(false);
      }
    },
    [apiClient, jobId],
  );

  useEffect(() => {
    let cancelled = false;
    stopPollingRef.current = false;
    const tick = async () => {
      if (cancelled || stopPollingRef.current) return;
      await fetchOnce();
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce]);

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return <Alert type="error">不正な Job ID です。</Alert>;
  }

  if (!item && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> 状態を取得中...
      </Box>
    );
  }

  if (error && !item) {
    return (
      <Alert type="error" header="ジョブの取得に失敗しました">
        {error}
      </Alert>
    );
  }

  if (!item) return null;

  const outputs = parseStackOutputs(item.stackOutputs);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
            再読み込み
          </Button>
        }
        description={`Job ID: ${item.jobId}`}
      >
        デプロイジョブ「{item.teamName}」
      </Header>

      <Container header={<Header variant="h2">ステータス</Header>}>
        <SpaceBetween size="m">
          <StatusIndicator type={STATUS_TYPE[item.status]}>{item.status}</StatusIndicator>
          {item.status === "FAILED" && item.failureReason && (
            <Alert type="error" header="失敗理由">
              {item.failureReason}
            </Alert>
          )}
          {!TERMINAL_STATUSES.has(item.status) && (
            <Box variant="small" color="text-status-info">
              {POLL_INTERVAL_MS / 1000} 秒ごとに自動更新します。
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">基本情報</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Problem ID", value: <code>{item.problemId}</code> },
              { label: "Team", value: item.teamName },
              { label: "AWS Account", value: <code>{item.awsAccountId}</code> },
              { label: "Region", value: item.region },
            ]}
          />
          <KeyValuePairs
            items={[
              { label: "Stack 名 prefix", value: <code>{item.namePrefix}</code> },
              {
                label: "Stack ID",
                value: item.stackId ? <code>{item.stackId}</code> : "(未割当)",
              },
              { label: "作成", value: item.createdAt },
              { label: "更新", value: item.updatedAt },
            ]}
          />
        </ColumnLayout>
      </Container>

      {Object.keys(outputs).length > 0 && (
        <Container header={<Header variant="h2">CloudFormation Outputs</Header>}>
          <KeyValuePairs
            items={Object.entries(outputs).map(([label, value]) => ({
              label,
              value: <code>{value}</code>,
            }))}
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
