/**
 * GameDay チームデプロイ管理ページ
 *
 * - 競技アカウント（チーム）の管理
 * - 問題を全チームへ CloudFormation デプロイ
 * - デプロイ状態のリアルタイム確認
 */

'use client';

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminProblem } from '@/lib/api/admin-types';
import { getProblem } from '@/lib/api/admin-problems';
import { getGameDayTeamDeploymentIssue } from '../../../../../../../../lib/api/gameday-team-deploy';

// ============================================================
// Types
// ============================================================

interface CompetitorAccount {
  id: string;
  name: string;
  provider: string;
  accountId: string;
  region: string;
  roleArn?: string;
  status: string;
}

interface DeploymentJob {
  id: string;
  eventId: string;
  problemId: string;
  competitorAccountId: string;
  teamName?: string;
  awsAccountId?: string;
  provider: string;
  region: string;
  status: string;
  stackName?: string;
  stackId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
}

// ============================================================
// Helpers
// ============================================================

type StatusType =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'loading'
  | 'stopped'
  | 'in-progress'
  | 'pending';

function mapJobStatus(status: string): StatusType {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'rolled_back':
      return 'error';
    case 'in_progress':
      return 'in-progress';
    case 'rollback_in_progress':
      return 'warning';
    case 'pending':
    case 'queued':
      return 'pending';
    case 'cancelled':
      return 'stopped';
    default:
      return 'info';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'in_progress':
      return 'In Progress';
    case 'rollback_in_progress':
      return 'Rolling Back';
    case 'rolled_back':
      return 'Rolled Back';
    case 'pending':
      return 'Pending';
    case 'queued':
      return 'Queued';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function hasActiveJobs(jobs: DeploymentJob[]): boolean {
  return jobs.some(
    (j) =>
      j.status === 'pending' ||
      j.status === 'queued' ||
      j.status === 'in_progress',
  );
}

// ============================================================
// API helpers
// ============================================================

async function fetchAccounts(
  eventId: string,
): Promise<{ accounts: CompetitorAccount[] }> {
  const res = await fetch(`/api/admin/events/${eventId}/competitor-accounts`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function createAccount(
  eventId: string,
  data: Omit<CompetitorAccount, 'id' | 'status'>,
): Promise<CompetitorAccount> {
  const res = await fetch(`/api/admin/events/${eventId}/competitor-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function deleteAccount(
  eventId: string,
  accountId: string,
): Promise<void> {
  const res = await fetch(
    `/api/admin/events/${eventId}/competitor-accounts/${accountId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(await res.text());
}

async function fetchJobs(
  eventId: string,
  problemId: string,
): Promise<{ jobs: DeploymentJob[] }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deployments`,
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function startDeploy(
  eventId: string,
  problemId: string,
): Promise<{ jobs: DeploymentJob[] }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deploy`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function retryJobApi(
  eventId: string,
  problemId: string,
  jobId: string,
): Promise<{ job: DeploymentJob }> {
  const res = await fetch(
    `/api/admin/events/${eventId}/problems/${problemId}/deployments/${jobId}/retry`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============================================================
// Page
// ============================================================

export default function GameDayDeploymentsPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;
  const problemId = params.problemId as string;

  const [problem, setProblem] = useState<AdminProblem | null>(null);
  const [problemLoading, setProblemLoading] = useState(true);
  const [accounts, setAccounts] = useState<CompetitorAccount[]>([]);
  const [jobs, setJobs] = useState<DeploymentJob[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [deployLoading, setDeployLoading] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Add account modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newAccount, setNewAccount] = useState({
    name: '',
    accountId: '',
    region: 'ap-northeast-1',
    roleArn: '',
  });
  const [addingAccount, setAddingAccount] = useState(false);
  const [addAccountError, setAddAccountError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const teamDeployIssue = problem
    ? getGameDayTeamDeploymentIssue(problem)
    : null;
  const deployDisabled =
    deployLoading ||
    problemLoading ||
    teamDeployIssue !== null ||
    accounts.length === 0;

  // ---- Data fetching ----

  const refreshJobs = useCallback(async () => {
    try {
      const data = await fetchJobs(eventId, problemId);
      setJobs(data.jobs);
    } catch (e) {
      console.error('Failed to refresh jobs', e);
    }
  }, [eventId, problemId]);

  const refreshProblem = useCallback(async () => {
    try {
      setProblemLoading(true);
      const data = await getProblem(problemId);
      setProblem(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '問題取得失敗');
    } finally {
      setProblemLoading(false);
    }
  }, [problemId]);

  const refreshAccounts = useCallback(async () => {
    try {
      setAccountsLoading(true);
      const data = await fetchAccounts(eventId);
      setAccounts(data.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'アカウント取得失敗');
    } finally {
      setAccountsLoading(false);
    }
  }, [eventId]);

  // ---- Polling / SSE ----

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      refreshJobs();
    }, 5000);
  }, [refreshJobs]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // SSE 接続
  useEffect(() => {
    const es = new EventSource(
      `/api/admin/events/${eventId}/problems/${problemId}/deployments/stream`,
    );
    sseRef.current = es;

    es.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: 'snapshot'; jobs: DeploymentJob[] }
        | { type: 'update'; job: DeploymentJob };

      if (payload.type === 'snapshot') {
        setJobs(payload.jobs);
        setJobsLoading(false);
      } else {
        setJobs((prev) =>
          prev.map((j) => (j.id === payload.job.id ? payload.job : j)),
        );
      }
    };

    es.onerror = () => {
      es.close();
      // SSE 失敗時はポーリングにフォールバック
      startPolling();
    };

    return () => {
      es.close();
      stopPolling();
    };
  }, [eventId, problemId, startPolling, stopPolling]);

  // ---- Initial load ----

  useEffect(() => {
    refreshProblem();
    refreshAccounts();
    // SSE が失敗する前の初期データ取得
    fetchJobs(eventId, problemId)
      .then((d) => {
        setJobs(d.jobs);
        setJobsLoading(false);
      })
      .catch(() => setJobsLoading(false));
  }, [eventId, problemId, refreshAccounts, refreshProblem]);

  // アクティブジョブがなければポーリングを止める
  useEffect(() => {
    if (!hasActiveJobs(jobs)) stopPolling();
    else startPolling();
  }, [jobs, startPolling, stopPolling]);

  // ---- Actions ----

  const handleDeploy = async () => {
    if (problemLoading || teamDeployIssue || accounts.length === 0) {
      return;
    }

    setDeployLoading(true);
    setError(null);
    try {
      const result = await startDeploy(eventId, problemId);
      setJobs(result.jobs);
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'デプロイ開始に失敗しました');
    } finally {
      setDeployLoading(false);
    }
  };

  const handleRetry = async (jobId: string) => {
    setRetryingIds((prev) => new Set(prev).add(jobId));
    try {
      await retryJobApi(eventId, problemId, jobId);
      await refreshJobs();
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'リトライに失敗しました');
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    setDeletingIds((prev) => new Set(prev).add(accountId));
    try {
      await deleteAccount(eventId, accountId);
      await refreshAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'アカウント削除に失敗しました');
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleAddAccount = async () => {
    setAddingAccount(true);
    setAddAccountError('');
    try {
      await createAccount(eventId, {
        name: newAccount.name,
        provider: 'aws',
        accountId: newAccount.accountId,
        region: newAccount.region,
        roleArn: newAccount.roleArn || undefined,
      });
      setShowAddModal(false);
      setNewAccount({
        name: '',
        accountId: '',
        region: 'ap-northeast-1',
        roleArn: '',
      });
      await refreshAccounts();
    } catch (e) {
      setAddAccountError(
        e instanceof Error ? e.message : 'アカウント追加に失敗しました',
      );
    } finally {
      setAddingAccount(false);
    }
  };

  // ============================================================
  // Render
  // ============================================================

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={
          problem?.title
            ? `${problem.title} をイベント参加チームの AWS アカウントへ配布します。`
            : undefined
        }
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="primary"
              onClick={handleDeploy}
              loading={deployLoading}
              disabled={deployDisabled}
            >
              全チームへデプロイ
            </Button>
            <Button
              onClick={() => router.push(`/admin/events/${eventId}/problems`)}
            >
              問題一覧に戻る
            </Button>
          </SpaceBetween>
        }
      >
        チームデプロイ管理
      </Header>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {teamDeployIssue && <Alert type="warning">{teamDeployIssue}</Alert>}

      {!teamDeployIssue && !problemLoading && accounts.length === 0 && (
        <Alert type="info">
          先に競技アカウントを追加してください。アカウントが 1 件もない場合は
          チーム配布を開始できません。
        </Alert>
      )}

      {/* 競技アカウント一覧 */}
      <Table
        loading={accountsLoading}
        loadingText="アカウントを読み込み中..."
        items={accounts}
        header={
          <Header
            counter={`(${accounts.length})`}
            actions={
              <Button
                variant="primary"
                iconName="add-plus"
                onClick={() => setShowAddModal(true)}
              >
                アカウント追加
              </Button>
            }
          >
            競技アカウント（チーム）
          </Header>
        }
        empty={
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <Box variant="h3">アカウントがありません</Box>
              <Box color="text-body-secondary">
                チームの AWS アカウントを追加してください。
              </Box>
              <Button variant="primary" onClick={() => setShowAddModal(true)}>
                アカウント追加
              </Button>
            </SpaceBetween>
          </Box>
        }
        columnDefinitions={[
          {
            id: 'name',
            header: 'チーム名',
            cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
          },
          {
            id: 'accountId',
            header: 'AWS アカウント ID',
            cell: (item) => item.accountId,
          },
          {
            id: 'region',
            header: 'リージョン',
            cell: (item) => item.region,
          },
          {
            id: 'roleArn',
            header: 'Role ARN',
            cell: (item) => item.roleArn ?? '—',
          },
          {
            id: 'actions',
            header: 'アクション',
            cell: (item) => (
              <Button
                variant="link"
                loading={deletingIds.has(item.id)}
                onClick={() => handleDeleteAccount(item.id)}
              >
                削除
              </Button>
            ),
          },
        ]}
      />

      {/* デプロイジョブ一覧 */}
      <Table
        loading={jobsLoading}
        loadingText="デプロイ状態を読み込み中..."
        items={jobs}
        header={
          <Header
            counter={`(${jobs.length})`}
            actions={
              <Button
                iconName="refresh"
                onClick={refreshJobs}
                loading={jobsLoading}
              >
                更新
              </Button>
            }
          >
            デプロイジョブ
          </Header>
        }
        empty={
          <Box textAlign="center" padding="l">
            <Box variant="h3">デプロイ履歴がありません</Box>
            <Box color="text-body-secondary" padding={{ top: 's' }}>
              「全チームへデプロイ」ボタンでデプロイを開始してください。
            </Box>
          </Box>
        }
        columnDefinitions={[
          {
            id: 'team',
            header: 'チーム',
            cell: (item) => (
              <Box fontWeight="bold">
                {item.teamName ?? item.competitorAccountId}
              </Box>
            ),
          },
          {
            id: 'awsAccount',
            header: 'AWS アカウント',
            cell: (item) => item.awsAccountId ?? '—',
          },
          {
            id: 'status',
            header: 'ステータス',
            cell: (item) => (
              <StatusIndicator type={mapJobStatus(item.status)}>
                {statusLabel(item.status)}
              </StatusIndicator>
            ),
          },
          {
            id: 'stackName',
            header: 'スタック名',
            cell: (item) => item.stackName ?? '—',
          },
          {
            id: 'retryCount',
            header: 'リトライ',
            cell: (item) => item.retryCount,
          },
          {
            id: 'completedAt',
            header: '完了時刻',
            cell: (item) =>
              item.completedAt
                ? new Date(item.completedAt).toLocaleString('ja-JP')
                : '—',
          },
          {
            id: 'error',
            header: 'エラー',
            cell: (item) =>
              item.error ? (
                <Box color="text-status-error" fontSize="body-s">
                  {item.error}
                </Box>
              ) : (
                '—'
              ),
          },
          {
            id: 'actions',
            header: 'アクション',
            cell: (item) =>
              item.status === 'failed' ? (
                <Button
                  variant="link"
                  loading={retryingIds.has(item.id)}
                  onClick={() => handleRetry(item.id)}
                >
                  リトライ
                </Button>
              ) : null,
          },
        ]}
      />

      {/* アカウント追加モーダル */}
      <Modal
        visible={showAddModal}
        onDismiss={() => {
          setShowAddModal(false);
          setAddAccountError('');
        }}
        header="競技アカウントを追加"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setShowAddModal(false);
                  setAddAccountError('');
                }}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={handleAddAccount}
                loading={addingAccount}
                disabled={!newAccount.name || !newAccount.accountId}
              >
                追加
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween size="m">
            {addAccountError && <Alert type="error">{addAccountError}</Alert>}
            <FormField label="チーム名" constraintText="必須">
              <Input
                value={newAccount.name}
                onChange={({ detail }) =>
                  setNewAccount((prev) => ({ ...prev, name: detail.value }))
                }
                placeholder="team01"
              />
            </FormField>
            <FormField label="AWS アカウント ID" constraintText="必須">
              <Input
                value={newAccount.accountId}
                onChange={({ detail }) =>
                  setNewAccount((prev) => ({
                    ...prev,
                    accountId: detail.value,
                  }))
                }
                placeholder="123456789012"
              />
            </FormField>
            <FormField label="リージョン">
              <Input
                value={newAccount.region}
                onChange={({ detail }) =>
                  setNewAccount((prev) => ({ ...prev, region: detail.value }))
                }
                placeholder="ap-northeast-1"
              />
            </FormField>
            <FormField
              label="Role ARN"
              description="AssumeRole で使用する IAM ロール ARN（省略時は環境変数の認証情報を使用）"
            >
              <Input
                value={newAccount.roleArn}
                onChange={({ detail }) =>
                  setNewAccount((prev) => ({ ...prev, roleArn: detail.value }))
                }
                placeholder="arn:aws:iam::123456789012:role/TenkaCloudDeployRole"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>
    </SpaceBetween>
  );
}
