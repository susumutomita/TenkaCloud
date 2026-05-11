import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError, useApiClient } from "../api/client";
import {
  DEPLOYMENT_STATUS_INDICATOR,
  type DeploymentSummary,
  deleteDeployment,
  getDeployment,
  getStackProgress,
  JOB_ID_RE,
  parseStackOutputs,
  type StackProgress,
  type StackProgressEvent,
  type StackProgressResource,
  statusToIndicator,
  TERMINAL_STATUSES,
} from "../api/deploy-client";
import type { AppConfig } from "../config";

const POLL_INTERVAL_MS = 5_000;

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
  // #534: StackEvents / Resources は基本情報と独立 state。CFn API が throttle / 権限不足で
  // 落ちても基本情報まで巻き込まない (= 別 state に閉じる)。
  const [stackProgress, setStackProgress] = useState<StackProgress | null>(null);
  const [stackProgressError, setStackProgressError] = useState<{
    message: string;
    notYetCreated: boolean;
  } | null>(null);
  const [stackProgressPending, setStackProgressPending] = useState(false);

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

  const fetchStackProgress = useCallback(async () => {
    if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
    setStackProgressPending(true);
    try {
      const progress = await getStackProgress(apiClient, jobId);
      setStackProgress(progress);
      setStackProgressError(null);
    } catch (err) {
      // CFn 失敗は基本情報を巻き込まない (= 別 state に閉じる)。
      // 409 (= stack 未割当 / deploy 極初期) は別 message に分けて「準備中」表示する。
      const notYetCreated = err instanceof ApiError && err.status === StatusCodes.CONFLICT;
      const message = err instanceof Error ? err.message : String(err);
      setStackProgressError({ message, notYetCreated });
    } finally {
      setStackProgressPending(false);
    }
  }, [apiClient, jobId]);

  useEffect(() => {
    let cancelled = false;
    stopPollingRef.current = false;
    const tick = async () => {
      if (cancelled || stopPollingRef.current) return;
      // 基本情報 + stack-progress を並列に fetch。stack-progress の error は基本情報を
      // 巻き込まない (= 別 state に閉じる)。Terminal 後も最終 stack 状態を 1 回 fetch するため
      // stopPollingRef は両 promise の after に評価する。
      await Promise.all([fetchOnce(), fetchStackProgress()]);
    };
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchOnce, fetchStackProgress]);

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
  const teamLoginKey = item.teamLoginKey;

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
          <StatusIndicator type={DEPLOYMENT_STATUS_INDICATOR[item.status]}>
            {item.status}
          </StatusIndicator>
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

      <StackProgressSection
        progress={stackProgress}
        error={stackProgressError}
        pending={stackProgressPending}
      />

      {teamLoginKey && (
        <Container
          header={
            <Header
              variant="h2"
              description="競技者にこのキーを渡してください。Participant Portal にログインするとこのチーム用の問題環境にアクセスできます。"
            >
              競技者 hand-off
            </Header>
          }
        >
          <KeyValuePairs
            items={[
              {
                label: "チーム共有ログインキー",
                value: (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Box variant="code">{teamLoginKey}</Box>
                    <Button
                      iconName="copy"
                      ariaLabel="ログインキーをコピー"
                      onClick={() => void navigator.clipboard?.writeText(teamLoginKey)}
                    >
                      コピー
                    </Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </Container>
      )}

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

/**
 * #534: CFn 進行状況セクション。Events / Resources / Console deep link を出す。
 *
 * - 初回 fetch 待ち (= progress === null かつ pending) → Spinner
 * - 取得失敗 → Alert (基本情報は別途表示済、ここの error は基本情報を汚さない)
 * - stack 未割当 (= deploy 極初期 / DDB 行はあるが CFn CreateStack 前) → 控えめな notice
 * - 成功 → Events / Resources の Table + 「CFn console を開く」link
 *
 * FAILED event があれば最上位に Alert で強調 (= operator が一目で原因を特定できる)。
 */
function StackProgressSection(props: {
  readonly progress: StackProgress | null;
  readonly error: { message: string; notYetCreated: boolean } | null;
  readonly pending: boolean;
}) {
  const { progress, error, pending } = props;

  // 初回ローディング: error も progress も無く、fetch in-flight。
  if (!progress && !error && pending) {
    return (
      <Container header={<Header variant="h2">Stack 進行状況</Header>}>
        <Box textAlign="center" padding="m">
          <Spinner /> CFn から取得中...
        </Box>
      </Container>
    );
  }

  // Error 表示。stack 未割当 (= API 側の `stack_not_yet_created` 409) は別 message に分ける。
  if (error && !progress) {
    return (
      <Container header={<Header variant="h2">Stack 進行状況</Header>}>
        {error.notYetCreated ? (
          <Box color="text-status-info">
            CFn Stack はまだ作成されていません。deploy worker (CodeBuild) が起動し次第、 ここに
            StackEvents / Resources が表示されます。
          </Box>
        ) : (
          <Alert type="warning" header="CFn の進行状況を取得できませんでした">
            {error.message}
          </Alert>
        )}
      </Container>
    );
  }

  if (!progress) return null;

  // 失敗 event を抽出 (= CREATE_FAILED / UPDATE_FAILED 等)。最初に検出した 1 件を Alert で
  // 強調する: operator が AWS Console を開かずに原因 logical id + reason を読める。
  const firstFailure = progress.events.find((e) => e.resourceStatus.endsWith("_FAILED"));

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            progress.stackStatus
              ? `現在の CFn Stack 状態: ${progress.stackStatus}`
              : "CFn StackEvents / Resources を CFn API から直接取得しています。"
          }
          actions={
            <Link href={progress.consoleUrl} external>
              CFn console を開く
            </Link>
          }
        >
          Stack 進行状況
        </Header>
      }
    >
      <SpaceBetween size="m">
        {firstFailure && (
          <Alert type="error" header={`失敗: ${firstFailure.logicalResourceId}`}>
            <Box>
              <code>{firstFailure.resourceType}</code> が <code>{firstFailure.resourceStatus}</code>{" "}
              になりました。
            </Box>
            {firstFailure.resourceStatusReason && (
              <Box variant="small">{firstFailure.resourceStatusReason}</Box>
            )}
          </Alert>
        )}

        <Table<StackProgressEvent>
          variant="embedded"
          header={<Header variant="h3">StackEvents (最新 {progress.events.length} 件)</Header>}
          items={[...progress.events]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              StackEvents はまだありません。
            </Box>
          }
          columnDefinitions={[
            {
              id: "timestamp",
              header: "時刻",
              cell: (e) => e.timestamp,
              width: 200,
            },
            {
              id: "logicalResourceId",
              header: "LogicalId",
              cell: (e) => <code>{e.logicalResourceId}</code>,
              width: 220,
            },
            {
              id: "resourceType",
              header: "Type",
              cell: (e) => <code>{e.resourceType}</code>,
              width: 220,
            },
            {
              id: "status",
              header: "Status",
              cell: (e) => (
                <StatusIndicator type={statusToIndicator(e.resourceStatus)}>
                  {e.resourceStatus}
                </StatusIndicator>
              ),
              width: 240,
            },
            {
              id: "reason",
              header: "Reason",
              cell: (e) => e.resourceStatusReason ?? "",
            },
          ]}
        />

        <Table<StackProgressResource>
          variant="embedded"
          header={<Header variant="h3">Resources ({progress.resources.length} 件)</Header>}
          items={[...progress.resources]}
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              Resources はまだ作成されていません。
            </Box>
          }
          columnDefinitions={[
            {
              id: "logicalResourceId",
              header: "LogicalId",
              cell: (r) => <code>{r.logicalResourceId}</code>,
              width: 220,
            },
            {
              id: "resourceType",
              header: "Type",
              cell: (r) => <code>{r.resourceType}</code>,
              width: 220,
            },
            {
              id: "status",
              header: "Status",
              cell: (r) => (
                <StatusIndicator type={statusToIndicator(r.resourceStatus)}>
                  {r.resourceStatus}
                </StatusIndicator>
              ),
              width: 240,
            },
            {
              id: "physicalResourceId",
              header: "PhysicalId",
              cell: (r) => (r.physicalResourceId ? <code>{r.physicalResourceId}</code> : ""),
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}
