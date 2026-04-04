/**
 * Attack Card
 *
 * 攻撃カタログカード
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { Attack } from '@/lib/api/gameday-types';
import { AttackTypeBadge } from './attack-type-badge';

interface AttackCardProps {
  attack: Attack;
  purchased?: boolean;
  cooldownUntil?: number;
  onPurchase?: () => void;
  onExecute?: () => void;
  purchasing?: boolean;
  executing?: boolean;
}

export function AttackCard({
  attack,
  purchased = false,
  cooldownUntil,
  onPurchase,
  onExecute,
  purchasing = false,
  executing = false,
}: AttackCardProps) {
  const { t } = useI18n();
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownRemaining(0);
      return;
    }

    function calc() {
      const diff = Math.max(
        0,
        Math.ceil(((cooldownUntil as number) - Date.now()) / 1000)
      );
      setCooldownRemaining(diff);
    }

    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const isCoolingDown = cooldownRemaining > 0;

  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={<AttackTypeBadge type={attack.attackType} />}
        >
          {attack.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Box color="text-body-secondary">{attack.description}</Box>

        <ColumnLayout columns={3} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">{t('gameday.cost')}</Box>
            <Box fontSize="heading-s" color="text-status-warning">
              {attack.purchaseCost}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">{t('gameday.damage')}</Box>
            <Box fontSize="heading-s" color="text-status-error">
              {attack.damage}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">{t('gameday.reward')}</Box>
            <Box fontSize="heading-s" color="text-status-success">
              {attack.reward}
            </Box>
          </div>
        </ColumnLayout>

        {isCoolingDown ? (
          <Box color="text-status-warning">
            {t('gameday.cooldown')}: {cooldownRemaining}s
          </Box>
        ) : null}

        {!purchased ? (
          <Button
            variant="normal"
            fullWidth
            onClick={onPurchase}
            loading={purchasing}
            disabled={purchasing}
          >
            {t('gameday.purchase')} ({attack.purchaseCost} pts)
          </Button>
        ) : (
          <Button
            variant="primary"
            fullWidth
            onClick={onExecute}
            loading={executing}
            disabled={isCoolingDown || executing}
          >
            {isCoolingDown ? `${cooldownRemaining}s` : t('gameday.execute')}
          </Button>
        )}
      </SpaceBetween>
    </Container>
  );
}
