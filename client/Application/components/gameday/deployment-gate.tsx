/**
 * DeploymentGate
 *
 * デプロイメント状態を確認し、未完了の場合はブロックメッセージを表示する。
 * 攻撃/防御/投票ページで共通利用する。
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useDeploymentStatus } from '@/lib/hooks/use-deployment-status';
import { useI18n } from '@/lib/i18n';

interface DeploymentGateProps {
  eventId: string | undefined;
  children: React.ReactNode;
}

export function DeploymentGate({ eventId, children }: DeploymentGateProps) {
  const { t } = useI18n();
  const { isReady, isChecking, status } = useDeploymentStatus(eventId);

  if (isChecking) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (!isReady && status) {
    const message =
      status.status === 'in_progress'
        ? t('gameday.deploymentInProgress')
        : status.status === 'failed'
          ? t('gameday.deploymentFailed')
          : t('gameday.deploymentNotReady');
    return (
      <Container>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m">
            <StatusIndicator
              type={status.status === 'in_progress' ? 'in-progress' : 'warning'}
            >
              {message}
            </StatusIndicator>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  return <>{children}</>;
}
