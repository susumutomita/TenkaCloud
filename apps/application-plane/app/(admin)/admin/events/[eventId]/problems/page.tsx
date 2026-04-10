/**
 * Admin Event Problems Page
 *
 * Cloudscape Design System - イベントに紐づく問題の管理・デプロイ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import type { SelectProps } from '@cloudscape-design/components/select';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AdminProblem, DeploymentStatus } from '@/lib/api/admin-types';
import {
  addProblemToEvent,
  deleteDeployment,
  deployProblem,
  getDeploymentStatus,
  getEventProblems,
  getProblems,
  removeProblemFromEvent,
} from '@/lib/api/admin-problems';
import { getGameDayTeamDeploymentIssue } from '../../../../../../lib/api/gameday-team-deploy';

// =============================================================================
// Types
// =============================================================================

interface DeployState {
  stackName?: string;
  region?: string;
  status?: string;
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

const REGION_OPTIONS: SelectProps.Option[] = [
  { label: 'アジアパシフィック (東京)', value: 'ap-northeast-1' },
  { label: 'アジアパシフィック (大阪)', value: 'ap-northeast-3' },
  { label: 'アジアパシフィック (ソウル)', value: 'ap-northeast-2' },
  { label: 'アジアパシフィック (シンガポール)', value: 'ap-southeast-1' },
  { label: '米国東部 (バージニア)', value: 'us-east-1' },
  { label: '米国西部 (オレゴン)', value: 'us-west-2' },
  { label: '欧州 (アイルランド)', value: 'eu-west-1' },
];

const STATUS_POLL_INTERVAL = 5000;

// =============================================================================
// Helpers
// =============================================================================

function getDifficultyBadge(difficulty: string) {
  switch (difficulty) {
    case 'easy':
      return <Badge color="green">Easy</Badge>;
    case 'medium':
      return <Badge color="blue">Medium</Badge>;
    case 'hard':
      return <Badge color="red">Hard</Badge>;
    default:
      return <Badge>{difficulty}</Badge>;
  }
}

function getDeployStatusIndicator(status: string | undefined) {
  if (!status) return null;
  if (status.includes('COMPLETE') && !status.includes('ROLLBACK')) {
    return <StatusIndicator type="success">{status}</StatusIndicator>;
  }
  if (status.includes('IN_PROGRESS')) {
    return <StatusIndicator type="in-progress">{status}</StatusIndicator>;
  }
  if (status.includes('FAILED') || status.includes('ROLLBACK')) {
    return <StatusIndicator type="error">{status}</StatusIndicator>;
  }
  return <StatusIndicator type="info">{status}</StatusIndicator>;
}

// =============================================================================
// Component
// =============================================================================

export default function AdminEventProblemsPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;

  const [problems, setProblems] = useState<AdminProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  // Add problem modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [allProblems, setAllProblems] = useState<AdminProblem[]>([]);
  const [addModalLoading, setAddModalLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  // Deploy modal
  const [deployTarget, setDeployTarget] = useState<AdminProblem | null>(null);
  const [selectedRegion, setSelectedRegion] =
    useState<SelectProps.Option | null>(REGION_OPTIONS[0]);
  const [dryRun, setDryRun] = useState(false);
  const [deploying, setDeploying] = useState(false);

  // Deploy states per problem
  const [deployStates, setDeployStates] = useState<Record<string, DeployState>>(
    {},
  );
  const [deletingDeploy, setDeletingDeploy] = useState<Set<string>>(new Set());
  const pollingRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Cleanup polling on unmount
  useEffect(() => {
    const intervals = pollingRef.current;
    return () => {
      Object.values(intervals).forEach(clearInterval);
    };
  }, []);

  const fetchProblems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getEventProblems(eventId);
      setProblems(data.problems);
    } catch (err) {
      setError(err instanceof Error ? err.message : '問題の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchProblems();
  }, [fetchProblems]);

  const handleRemove = async (problemId: string) => {
    setRemovingIds((prev) => new Set(prev).add(problemId));
    try {
      await removeProblemFromEvent(eventId, problemId);
      await fetchProblems();
    } catch {
      // Error handling
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(problemId);
        return next;
      });
    }
  };

  const handleOpenAddModal = async () => {
    setShowAddModal(true);
    setAddModalLoading(true);
    try {
      const data = await getProblems({ limit: 100 });
      const existingIds = new Set(problems.map((p) => p.id));
      setAllProblems(data.problems.filter((p) => !existingIds.has(p.id)));
    } catch {
      setAllProblems([]);
    } finally {
      setAddModalLoading(false);
    }
  };

  const handleAddProblem = async (problemId: string) => {
    setAddingId(problemId);
    try {
      await addProblemToEvent(eventId, problemId);
      setShowAddModal(false);
      await fetchProblems();
    } catch {
      // Error handling
    } finally {
      setAddingId(null);
    }
  };

  // --- Deploy ---

  const startPolling = (
    problemId: string,
    stackName: string,
    region: string,
  ) => {
    if (pollingRef.current[problemId]) {
      clearInterval(pollingRef.current[problemId]);
    }
    pollingRef.current[problemId] = setInterval(async () => {
      try {
        const status: DeploymentStatus = await getDeploymentStatus(
          problemId,
          stackName,
          region,
        );
        setDeployStates((prev) => ({
          ...prev,
          [problemId]: {
            stackName,
            region,
            status: status.status,
          },
        }));
        if (!status.status.includes('IN_PROGRESS')) {
          clearInterval(pollingRef.current[problemId]);
          delete pollingRef.current[problemId];
        }
      } catch {
        clearInterval(pollingRef.current[problemId]);
        delete pollingRef.current[problemId];
      }
    }, STATUS_POLL_INTERVAL);
  };

  const handleDeploy = async () => {
    if (!deployTarget || !selectedRegion?.value) return;
    setDeploying(true);
    try {
      const result = await deployProblem(deployTarget.id, {
        region: selectedRegion.value,
        dryRun,
      });
      setDeployStates((prev) => ({
        ...prev,
        [deployTarget.id]: {
          stackName: result.stackName,
          region: selectedRegion.value,
          status: 'CREATE_IN_PROGRESS',
        },
      }));
      setDeployTarget(null);
      if (!dryRun) {
        startPolling(deployTarget.id, result.stackName, selectedRegion.value);
      }
    } catch (err) {
      setDeployStates((prev) => ({
        ...prev,
        [deployTarget.id]: {
          error: err instanceof Error ? err.message : 'デプロイに失敗しました',
        },
      }));
      setDeployTarget(null);
    } finally {
      setDeploying(false);
    }
  };

  const handleDeleteDeploy = async (problemId: string) => {
    const state = deployStates[problemId];
    if (!state?.stackName || !state.region) return;
    setDeletingDeploy((prev) => new Set(prev).add(problemId));
    try {
      await deleteDeployment(problemId, state.stackName, state.region);
      setDeployStates((prev) => {
        const next = { ...prev };
        delete next[problemId];
        return next;
      });
    } catch {
      // Error handling
    } finally {
      setDeletingDeploy((prev) => {
        const next = new Set(prev);
        next.delete(problemId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xl">
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={handleOpenAddModal}>
              問題を追加
            </Button>
            <Button onClick={() => router.push('/admin/problems/new')}>
              新規問題作成
            </Button>
            <Button onClick={() => router.push(`/admin/events/${eventId}`)}>
              イベントに戻る
            </Button>
          </SpaceBetween>
        }
      >
        問題管理
      </Header>

      {error && (
        <Container>
          <SpaceBetween size="m" direction="vertical" alignItems="center">
            <StatusIndicator type="error">{error}</StatusIndicator>
            <Button onClick={fetchProblems}>再読み込み</Button>
          </SpaceBetween>
        </Container>
      )}

      {!error && (
        <Table
          loading={loading}
          loadingText="問題を読み込み中..."
          items={problems}
          header={
            <Header counter={`(${problems.length})`}>イベントの問題一覧</Header>
          }
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="m">
                <Box variant="h3">問題がまだありません</Box>
                <Box color="text-body-secondary">
                  問題を追加してイベントを構成しましょう。
                </Box>
                <Button variant="primary" onClick={handleOpenAddModal}>
                  問題を追加
                </Button>
              </SpaceBetween>
            </Box>
          }
          columnDefinitions={[
            {
              id: 'title',
              header: 'タイトル',
              cell: (item) => <Box fontWeight="bold">{item.title}</Box>,
            },
            {
              id: 'category',
              header: 'カテゴリ',
              cell: (item) => item.category,
            },
            {
              id: 'difficulty',
              header: '難易度',
              cell: (item) => getDifficultyBadge(item.difficulty),
            },
            {
              id: 'scoring',
              header: '配点',
              cell: (item) => {
                const total = item.scoring.criteria.reduce(
                  (sum, c) => sum + c.maxPoints,
                  0,
                );
                return `${total} pts`;
              },
            },
            {
              id: 'deploy',
              header: 'デプロイ',
              cell: (item) => {
                const state = deployStates[item.id];
                if (state?.error) {
                  return (
                    <SpaceBetween direction="horizontal" size="xs">
                      <StatusIndicator type="error">失敗</StatusIndicator>
                      <Button
                        variant="link"
                        onClick={() => setDeployTarget(item)}
                      >
                        再試行
                      </Button>
                    </SpaceBetween>
                  );
                }
                if (state?.status) {
                  return (
                    <SpaceBetween direction="horizontal" size="xs">
                      {getDeployStatusIndicator(state.status)}
                      {!state.status.includes('IN_PROGRESS') &&
                        state.status.includes('COMPLETE') &&
                        !state.status.includes('ROLLBACK') && (
                          <Button
                            variant="link"
                            loading={deletingDeploy.has(item.id)}
                            onClick={() => handleDeleteDeploy(item.id)}
                          >
                            破棄
                          </Button>
                        )}
                    </SpaceBetween>
                  );
                }
                return (
                  <Button variant="link" onClick={() => setDeployTarget(item)}>
                    デプロイ
                  </Button>
                );
              },
            },
            {
              id: 'actions',
              header: 'アクション',
              cell: (item) => {
                const teamDeployIssue = getGameDayTeamDeploymentIssue(item);

                return (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      variant="link"
                      onClick={() =>
                        router.push(`/admin/problems/${item.id}/edit`)
                      }
                    >
                      編集
                    </Button>
                    <SpaceBetween size="xxs">
                      <Button
                        variant="link"
                        disabled={teamDeployIssue !== null}
                        onClick={() =>
                          router.push(
                            `/admin/events/${eventId}/problems/${item.id}/deployments`,
                          )
                        }
                      >
                        チームへデプロイ
                      </Button>
                      {teamDeployIssue && (
                        <Box color="text-body-secondary" fontSize="body-s">
                          {teamDeployIssue}
                        </Box>
                      )}
                    </SpaceBetween>
                    <Button
                      variant="link"
                      loading={removingIds.has(item.id)}
                      onClick={() => handleRemove(item.id)}
                    >
                      削除
                    </Button>
                  </SpaceBetween>
                );
              },
            },
          ]}
        />
      )}

      {/* Add Problem Modal */}
      <Modal
        visible={showAddModal}
        onDismiss={() => setShowAddModal(false)}
        header="問題を選択"
        size="large"
      >
        {addModalLoading ? (
          <Box textAlign="center" padding="l">
            <Spinner size="large" />
          </Box>
        ) : allProblems.length === 0 ? (
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <Box>追加可能な問題がありません</Box>
              <Button onClick={() => router.push('/admin/problems/new')}>
                新規問題作成
              </Button>
            </SpaceBetween>
          </Box>
        ) : (
          <Table
            items={allProblems}
            columnDefinitions={[
              {
                id: 'title',
                header: 'タイトル',
                cell: (item) => item.title,
              },
              {
                id: 'category',
                header: 'カテゴリ',
                cell: (item) => item.category,
              },
              {
                id: 'difficulty',
                header: '難易度',
                cell: (item) => getDifficultyBadge(item.difficulty),
              },
              {
                id: 'add',
                header: '',
                cell: (item) => (
                  <Button
                    variant="primary"
                    loading={addingId === item.id}
                    onClick={() => handleAddProblem(item.id)}
                  >
                    追加
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>

      {/* Deploy Modal */}
      <Modal
        visible={deployTarget !== null}
        onDismiss={() => setDeployTarget(null)}
        header={`デプロイ: ${deployTarget?.title ?? ''}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeployTarget(null)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={deploying}
                onClick={handleDeploy}
              >
                {dryRun ? 'ドライラン実行' : 'デプロイ実行'}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          <FormField label="リージョン">
            <Select
              selectedOption={selectedRegion}
              onChange={({ detail }) =>
                setSelectedRegion(detail.selectedOption)
              }
              options={REGION_OPTIONS}
              placeholder="リージョンを選択"
            />
          </FormField>
          <FormField label="ドライラン">
            <Toggle
              checked={dryRun}
              onChange={({ detail }) => setDryRun(detail.checked)}
            >
              テンプレートの検証のみ（実際のデプロイは行わない）
            </Toggle>
          </FormField>
          {deployTarget?.deployment?.providers && (
            <FormField label="対応プロバイダー">
              <SpaceBetween direction="horizontal" size="xs">
                {deployTarget.deployment.providers.map((p) => (
                  <Badge key={p} color="blue">
                    {p.toUpperCase()}
                  </Badge>
                ))}
              </SpaceBetween>
            </FormField>
          )}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
