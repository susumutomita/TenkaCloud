/**
 * Defense Trench (防衛塹壕)
 *
 * Cloudscape Design System — 受けている攻撃一覧、ヒント購入、脆弱性修正報告
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveDefense, purchaseHint, reportFix } from '@/lib/api/gameday';
import type { AttackLog } from '@/lib/api/gameday-types';
import { DeploymentGate } from '@/components/gameday/deployment-gate';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useI18n } from '@/lib/i18n';
import { useNotifications } from '@/lib/notifications';

export default function DefensePage() {
  const { t, locale } = useI18n();
  const { eventId, teamId } = useGamedaySession();
  const { addNotification } = useNotifications();
  const [attacks, setAttacks] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [hintLoading, setHintLoading] = useState<Record<string, boolean>>({});
  const [fixLoading, setFixLoading] = useState<Record<string, boolean>>({});
  const previousAttackIdsRef = useRef<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const data = await getActiveDefense(eventId, teamId);
      const activeAttacks = data.attacks.filter((a) => !a.neutralized);
      for (const attack of activeAttacks) {
        if (
          !previousAttackIdsRef.current.has(attack.attackId) &&
          previousAttackIdsRef.current.size > 0
        ) {
          addNotification({
            type: 'attack_received',
            title: '攻撃を受けています',
            message: `${attack.attackerTeamId} から ${attack.attackSlug} 攻撃を受けました`,
            severity: 'error',
          });
        }
      }
      previousAttackIdsRef.current = new Set(
        activeAttacks.map((a) => a.attackId),
      );
      setAttacks(data.attacks);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId, addNotification]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handlePurchaseHint = async (attackId: string) => {
    if (!eventId || !teamId) return;
    setHintLoading((prev) => ({ ...prev, [attackId]: true }));
    try {
      const result = await purchaseHint(eventId, teamId, attackId);
      setHints((prev) => ({ ...prev, [attackId]: result.hint }));
    } catch {
      // ignore
    } finally {
      setHintLoading((prev) => ({ ...prev, [attackId]: false }));
    }
  };

  const handleReportFix = async (vulnerabilitySlug: string) => {
    if (!eventId || !teamId) return;
    setFixLoading((prev) => ({ ...prev, [vulnerabilitySlug]: true }));
    try {
      await reportFix(eventId, teamId, vulnerabilitySlug);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setFixLoading((prev) => ({ ...prev, [vulnerabilitySlug]: false }));
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error) {
    return (
      <Container>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m">
            <StatusIndicator type="error">{error.message}</StatusIndicator>
            <Button onClick={fetchData}>{t('common.retry')}</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const active = attacks.filter((attack) => !attack.neutralized);
  const neutralized = attacks.filter((attack) => attack.neutralized);

  const formatTime = (timestamp: string) =>
    new Date(timestamp).toLocaleTimeString(
      locale === 'ja' ? 'ja-JP' : 'en-US',
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
    );

  return (
    <DeploymentGate eventId={eventId}>
      <SpaceBetween size="l">
        <Header variant="h1" description={t('gameday.defenseDescription')}>
          {t('gameday.defenseTrench')}
        </Header>

        <Table
          header={
            <Header
              counter={`(${active.length})`}
              description={t('gameday.defenseDescription')}
            >
              {t('gameday.underAttack')}
            </Header>
          }
          items={active}
          columnDefinitions={[
            {
              id: 'attack',
              header: t('gameday.attackName'),
              cell: (attack) => <Box variant="code">{attack.attackSlug}</Box>,
            },
            {
              id: 'attacker',
              header: t('gameday.attacker'),
              cell: (attack) => attack.attackerTeamId,
            },
            {
              id: 'damage',
              header: t('gameday.damage'),
              cell: (attack) => (
                <Box color="text-status-error">{attack.damage}</Box>
              ),
              width: 100,
            },
            {
              id: 'time',
              header: t('gameday.time'),
              cell: (attack) => formatTime(attack.createdAt),
              width: 120,
            },
            {
              id: 'hint',
              header: t('gameday.hint'),
              cell: (attack) =>
                hints[attack.attackId] ? (
                  <StatusIndicator type="info">
                    {hints[attack.attackId]}
                  </StatusIndicator>
                ) : (
                  <Button
                    variant="link"
                    loading={hintLoading[attack.attackId]}
                    onClick={() => handlePurchaseHint(attack.attackId)}
                  >
                    {t('gameday.hint')}
                  </Button>
                ),
            },
            {
              id: 'fix',
              header: t('gameday.reportFix'),
              cell: (attack) => (
                <Button
                  variant="primary"
                  loading={fixLoading[attack.attackSlug]}
                  onClick={() => handleReportFix(attack.attackSlug)}
                >
                  {t('gameday.reportFix')}
                </Button>
              ),
              width: 160,
            },
          ]}
          empty={t('gameday.noActiveAttacks')}
          sortingDisabled
          footer={
            <Box
              textAlign="center"
              color="text-body-secondary"
              fontSize="body-s"
            >
              <em>
                {locale === 'ja'
                  ? '10秒ごとに自動更新'
                  : 'Refreshes every 10 seconds'}
              </em>
            </Box>
          }
        />

        {neutralized.length > 0 ? (
          <Table
            header={
              <Header counter={`(${neutralized.length})`}>
                {t('gameday.fixed')}
              </Header>
            }
            items={neutralized}
            columnDefinitions={[
              {
                id: 'attack',
                header: t('gameday.attackName'),
                cell: (attack) => <Box variant="code">{attack.attackSlug}</Box>,
              },
              {
                id: 'attacker',
                header: t('gameday.attacker'),
                cell: (attack) => attack.attackerTeamId,
              },
              {
                id: 'status',
                header: t('gameday.result'),
                cell: () => (
                  <StatusIndicator type="success">
                    {t('gameday.mitigated')}
                  </StatusIndicator>
                ),
              },
              {
                id: 'time',
                header: t('gameday.time'),
                cell: (attack) => formatTime(attack.createdAt),
                width: 120,
              },
            ]}
            empty=""
            sortingDisabled
          />
        ) : null}
      </SpaceBetween>
    </DeploymentGate>
  );
}
