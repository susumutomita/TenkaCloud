/**
 * Alliance Card
 *
 * 同盟カード（承認/破棄ボタン）
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useI18n } from '@/lib/i18n';
import type { Alliance } from '@/lib/api/gameday-types';
import { AllianceStatusBadge } from './alliance-status-badge';

interface AllianceCardProps {
  alliance: Alliance;
  myTeamId: string;
  onAccept?: () => void;
  onBreak?: () => void;
  loading?: boolean;
}

export function AllianceCard({
  alliance,
  myTeamId,
  onAccept,
  onBreak,
  loading = false,
}: AllianceCardProps) {
  const { t } = useI18n();
  const isIncoming = alliance.targetTeamId === myTeamId;
  const partnerTeamId = isIncoming
    ? alliance.requesterTeamId
    : alliance.targetTeamId;

  const time = new Date(alliance.createdAt).toLocaleDateString('ja-JP', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={<AllianceStatusBadge status={alliance.status} />}
        >
          {partnerTeamId}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Box variant="awsui-key-label">
          {isIncoming ? t('gameday.received') : t('gameday.sent')} - {time}
        </Box>

        <SpaceBetween direction="horizontal" size="xs">
          {alliance.status === 'PENDING' && isIncoming ? (
            <Button
              variant="primary"
              onClick={onAccept}
              loading={loading}
              disabled={loading}
            >
              {t('gameday.accept')}
            </Button>
          ) : null}
          {alliance.status === 'ACTIVE' ? (
            <Button
              variant="normal"
              onClick={onBreak}
              loading={loading}
              disabled={loading}
            >
              {t('gameday.break')}
            </Button>
          ) : null}
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
