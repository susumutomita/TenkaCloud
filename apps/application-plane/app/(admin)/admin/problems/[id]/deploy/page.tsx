/**
 * Admin Problem Deploy Page
 *
 * Cloudscape Design System
 * CloudFormation スタックのデプロイ・ステータス監視・削除
 */

'use client';

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import type { SelectProps } from '@cloudscape-design/components/select';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeploymentStatus, StackEvent } from '@/lib/api/admin-types';
import {
  deleteDeployment,
  deployProblem,
  getDeployStatus,
} from '@/lib/api/deployment';

const REGIONS: SelectProps.Option[] = [
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'eu-west-1', label: 'Europe (Ireland)' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
];

const AUTO_REFRESH_INTERVAL = 5000;

type StatusIndicatorType =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'loading'
  | 'stopped'
  | 'in-progress'
  | 'pending';

function mapStackStatus(status: string): StatusIndicatorType {
  if (status.includes('COMPLETE') && !status.includes('ROLLBACK')) {
    return 'success';
  }
  if (status.includes('IN_PROGRESS')) {
    return 'in-progress';
  }
  if (status.includes('FAILED') || status.includes('ROLLBACK')) {
    return 'error';
  }
  return 'info';
}

function isInProgress(status: string): boolean {
  return status.includes('IN_PROGRESS');
}

export default function AdminProblemDeployPage() {
  const params = useParams();
  const problemId = params.id as string;

  const [selectedRegion, setSelectedRegion] =
    useState<SelectProps.Option | null>(REGIONS[0]);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState('');
  const [deploymentStatus, setDeploymentStatus] =
    useState<DeploymentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAutoRefresh = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      setStatusLoading(true);
      const data = await getDeployStatus(problemId);
      setDeploymentStatus(data);
      if (!isInProgress(data.status)) {
        stopAutoRefresh();
      }
    } catch {
      // ステータス取得失敗は無視（まだデプロイされていない場合など）
    } finally {
      setStatusLoading(false);
    }
  }, [problemId, stopAutoRefresh]);

  const startAutoRefresh = useCallback(() => {
    stopAutoRefresh();
    timerRef.current = setInterval(() => {
      fetchStatus();
    }, AUTO_REFRESH_INTERVAL);
  }, [fetchStatus, stopAutoRefresh]);

  useEffect(() => {
    fetchStatus();
    return () => stopAutoRefresh();
  }, [fetchStatus, stopAutoRefresh]);

  const handleDeploy = async () => {
    if (!selectedRegion?.value) return;

    setDeploying(true);
    setDeployError('');
    try {
      const result = await deployProblem(problemId, selectedRegion.value);
      setDeploymentStatus({
        stackName: result.stackName,
        stackId: result.stackId,
        status: 'CREATE_IN_PROGRESS',
        events: [],
      });
      startAutoRefresh();
    } catch (err) {
      setDeployError(
        err instanceof Error ? err.message : 'デプロイに失敗しました'
      );
    } finally {
      setDeploying(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteDeployment(problemId);
      setDeploymentStatus((prev) =>
        prev ? { ...prev, status: 'DELETE_IN_PROGRESS' } : null
      );
      setDeleteModalVisible(false);
      startAutoRefresh();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'スタックの削除に失敗しました'
      );
    } finally {
      setDeleting(false);
    }
  };

  const events: StackEvent[] = deploymentStatus?.events ?? [];
  const outputs = deploymentStatus?.outputs ?? {};
  const hasOutputs = Object.keys(outputs).length > 0;

  return (
    <SpaceBetween size="l">
      <Header variant="h1">AWS CloudFormation デプロイ</Header>

      {/* デプロイ設定 */}
      <Container header={<Header variant="h2">デプロイ設定</Header>}>
        <SpaceBetween size="l">
          {deployError && (
            <Alert
              type="error"
              dismissible
              onDismiss={() => setDeployError('')}
            >
              {deployError}
            </Alert>
          )}
          <SpaceBetween size="m">
            <Box>
              <Box variant="awsui-key-label">リージョン</Box>
              <Select
                selectedOption={selectedRegion}
                onChange={({ detail }) =>
                  setSelectedRegion(detail.selectedOption)
                }
                options={REGIONS}
                placeholder="リージョンを選択"
                disabled={deploying}
                data-testid="region-select"
              />
            </Box>
            <Button
              variant="primary"
              onClick={handleDeploy}
              loading={deploying}
              disabled={!selectedRegion}
            >
              デプロイ開始
            </Button>
          </SpaceBetween>
        </SpaceBetween>
      </Container>

      {/* ステータス表示 */}
      {deploymentStatus && (
        <Container
          header={
            <Header
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="refresh"
                    onClick={fetchStatus}
                    loading={statusLoading}
                  >
                    更新
                  </Button>
                  <Button
                    onClick={() => setDeleteModalVisible(true)}
                    disabled={isInProgress(deploymentStatus.status) || deleting}
                  >
                    スタック削除
                  </Button>
                </SpaceBetween>
              }
            >
              スタックステータス
            </Header>
          }
        >
          <SpaceBetween size="l">
            <SpaceBetween size="m">
              <Box>
                <Box variant="awsui-key-label">スタック名</Box>
                <Box>{deploymentStatus.stackName}</Box>
              </Box>
              <Box>
                <Box variant="awsui-key-label">ステータス</Box>
                <StatusIndicator type={mapStackStatus(deploymentStatus.status)}>
                  {deploymentStatus.status}
                </StatusIndicator>
              </Box>
              {deploymentStatus.statusReason && (
                <Box>
                  <Box variant="awsui-key-label">理由</Box>
                  <Box>{deploymentStatus.statusReason}</Box>
                </Box>
              )}
            </SpaceBetween>

            {/* Outputs 表示 */}
            {hasOutputs && (
              <KeyValuePairs
                columns={2}
                items={Object.entries(outputs).map(([key, value]) => ({
                  label: key,
                  value,
                  id: key,
                }))}
              />
            )}
          </SpaceBetween>
        </Container>
      )}

      {/* スタックイベントテーブル */}
      {deploymentStatus && (
        <Table
          header={<Header variant="h2">スタックイベント</Header>}
          columnDefinitions={[
            {
              id: 'timestamp',
              header: 'タイムスタンプ',
              cell: (item: StackEvent) =>
                new Date(item.timestamp).toLocaleString('ja-JP'),
              sortingField: 'timestamp',
            },
            {
              id: 'logicalResourceId',
              header: 'リソース',
              cell: (item: StackEvent) => item.logicalResourceId,
            },
            {
              id: 'resourceType',
              header: 'タイプ',
              cell: (item: StackEvent) => item.resourceType,
            },
            {
              id: 'resourceStatus',
              header: 'ステータス',
              cell: (item: StackEvent) => (
                <StatusIndicator type={mapStackStatus(item.resourceStatus)}>
                  {item.resourceStatus}
                </StatusIndicator>
              ),
            },
            {
              id: 'reason',
              header: '理由',
              cell: (item: StackEvent) => item.resourceStatusReason ?? '-',
            },
          ]}
          items={events}
          loading={statusLoading}
          loadingText="イベントを読み込み中..."
          empty={
            <Box textAlign="center" color="inherit">
              <b>イベントなし</b>
              <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                デプロイを開始するとイベントが表示されます
              </Box>
            </Box>
          }
          sortingDisabled
          variant="embedded"
        />
      )}

      {/* 削除確認モーダル */}
      <Modal
        visible={deleteModalVisible}
        onDismiss={() => {
          setDeleteModalVisible(false);
          setDeleteError('');
        }}
        header="スタック削除の確認"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setDeleteModalVisible(false);
                  setDeleteError('');
                }}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={handleDelete}
                loading={deleting}
              >
                削除
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {deleteError && <Alert type="error">{deleteError}</Alert>}
          <Box variant="p">
            スタック「{deploymentStatus?.stackName}」を削除します。
            この操作は取り消せません。
          </Box>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
