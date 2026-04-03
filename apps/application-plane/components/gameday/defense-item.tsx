/**
 * Defense Item
 *
 * 受けた攻撃の行コンポーネント
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useI18n } from '@/lib/i18n';
import type { AttackLog } from '@/lib/api/gameday-types';
import { AttackTypeBadge } from './attack-type-badge';

interface DefenseItemProps {
  attack: AttackLog;
  onPurchaseHint?: () => void;
  onReportFix?: () => void;
  hintLoading?: boolean;
  fixLoading?: boolean;
  hint?: string;
}

export function DefenseItem({
  attack,
  onPurchaseHint,
  onReportFix,
  hintLoading = false,
  fixLoading = false,
  hint,
}: DefenseItemProps) {
  const { t } = useI18n();
  const time = new Date(attack.createdAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <AttackTypeBadge
                type={attack.success ? 'vulnerability' : 'chaos'}
              />
              {attack.neutralized ? (
                <Badge color="green">{t('gameday.mitigated')}</Badge>
              ) : null}
            </SpaceBetween>
          }
        >
          {attack.attackSlug}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="l">
          <Box variant="awsui-key-label">{time}</Box>
          <Box>
            {t('gameday.damage')}: {attack.damage}
          </Box>
          <Box>
            {t('gameday.attacker')}: {attack.attackerTeamId}
          </Box>
          <StatusIndicator type={attack.success ? 'success' : 'error'}>
            {attack.success ? t('gameday.impacted') : t('gameday.defended')}
          </StatusIndicator>
        </SpaceBetween>

        {hint ? (
          <Box color="text-status-info">
            {t('gameday.hint')}: {hint}
          </Box>
        ) : null}

        {!attack.neutralized ? (
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="normal"
              onClick={onPurchaseHint}
              loading={hintLoading}
              disabled={hintLoading || !!hint}
            >
              {t('gameday.hint')}
            </Button>
            <Button
              variant="primary"
              onClick={onReportFix}
              loading={fixLoading}
              disabled={fixLoading}
            >
              {t('gameday.reportFix')}
            </Button>
          </SpaceBetween>
        ) : null}
      </SpaceBetween>
    </Container>
  );
}
