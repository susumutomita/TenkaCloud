import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator, {
  type StatusIndicatorProps,
} from "@cloudscape-design/components/status-indicator";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useApiClient } from "../api/client";
import {
  type DeploymentStatus,
  type DeploymentSummary,
  deleteDeployment,
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
  const apiClient = useApiClient(config);
  const [item, setItem] = useState<DeploymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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

  const handleDelete = useCallback(async () => {
    if (!apiClient || !jobId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDeployment(apiClient, jobId);
      setDeleteModalOpen(false);
      // DELETING / DELETE_COMPLETE 遷移は StatusUpdater (1 min) が反映する。
      // 既存の polling が拾うので追加フェッチ不要、stop flag も解除して継続。
      stopPollingRef.current = false;
      await fetchOnce({ showSpinner: false });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [apiClient, jobId, fetchOnce]);

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
  const canDelete = item.status !== "DELETING" && item.status !== "DELETED";

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => fetchOnce({ showSpinner: true })} loading={manualRefreshing}>
              再読み込み
            </Button>
            <Button
              variant="normal"
              iconName="delete-marker"
              disabled={!canDelete}
              onClick={() => {
                setDeleteError(null);
                setDeleteModalOpen(true);
              }}
            >
              削除
            </Button>
          </SpaceBetween>
        }
        description={`Job ID: ${item.jobId}`}
      >
        デプロイジョブ「{item.displayTeamName ?? item.teamName}」
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
              {
                label: "表示名 (競技者選択)",
                value: item.displayTeamName ?? "(未設定)",
              },
              { label: "内部 slug (operator 入力)", value: <code>{item.teamName}</code> },
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

      <Modal
        visible={deleteModalOpen}
        onDismiss={() => setDeleteModalOpen(false)}
        header={`「${item.teamName}」のデプロイを削除`}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleteModalOpen(false)} disabled={deleting}>
                キャンセル
              </Button>
              <Button variant="primary" loading={deleting} onClick={handleDelete}>
                削除する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            競技アカウント (<code>{item.awsAccountId}</code> / {item.region}) で起動中の
            CloudFormation Stack <code>{item.namePrefix}</code> を削除します。
          </Box>
          <Box variant="small" color="text-status-warning">
            この操作は取り消せません。実際の削除は次の StatusUpdater 周期 (最大 1 分)
            で実行されます。
          </Box>
          {deleteError && <Alert type="error">{deleteError}</Alert>}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
