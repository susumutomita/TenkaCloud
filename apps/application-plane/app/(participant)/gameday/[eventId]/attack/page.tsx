/**
 * Attack Station (攻撃ステーション)
 *
 * Cloudscape Design System — 攻撃カタログ、ターゲット選択、攻撃履歴テーブル
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import {
  executeAttack,
  getAttackCatalog,
  getAttackHistory,
  getParticipantTeams,
  purchaseAttack,
} from '@/lib/api/gameday';
import type { Attack, AttackLog, CooldownError } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useI18n } from '@/lib/i18n';

export default function AttackPage() {
  const { t, locale } = useI18n();
  const { eventId, teamId } = useGamedaySession();
  const [catalog, setCatalog] = useState<Attack[]>([]);
  const [history, setHistory] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [purchasing, setPurchasing] = useState<Record<string, boolean>>({});
  const [executing, setExecuting] = useState<Record<string, boolean>>({});
  const [selectedTarget, setSelectedTarget] =
    useState<SelectProps.Option | null>(null);
  const [teamOptions, setTeamOptions] = useState<SelectProps.Option[]>([]);

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const [catalogData, historyData] = await Promise.all([
        getAttackCatalog(eventId),
        getAttackHistory(eventId, teamId),
      ]);
      setCatalog(catalogData.attacks);
      setHistory(historyData.history);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => {
    if (!eventId) return;
    getParticipantTeams(eventId)
      .then((data) => {
        const options = data.teams
          .filter((team) => team.teamId !== teamId)
          .map((team) => ({
            value: team.teamId,
            label: team.teamName,
          }));
        setTeamOptions(options);
      })
      .catch(() => {});
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePurchase = async (attackId: string) => {
    if (!eventId || !teamId) return;
    setPurchasing((prev) => ({ ...prev, [attackId]: true }));
    try {
      await purchaseAttack(eventId, teamId, attackId);
      setPurchasedIds((prev) => new Set(prev).add(attackId));
    } catch {
      // ignore
    } finally {
      setPurchasing((prev) => ({ ...prev, [attackId]: false }));
    }
  };

  const handleExecute = async (attackId: string) => {
    if (!eventId || !teamId || !selectedTarget?.value) return;
    setExecuting((prev) => ({ ...prev, [attackId]: true }));
    try {
      await executeAttack(eventId, teamId, attackId, selectedTarget.value);
      await fetchData();
    } catch (err) {
      const typedError = err as Error & {
        status?: number;
        body?: CooldownError;
      };
      if (typedError.status === 429 && typedError.body?.remainingSeconds) {
        const remainingSeconds = typedError.body.remainingSeconds;
        setCooldowns((prev) => ({
          ...prev,
          [attackId]: Date.now() + remainingSeconds * 1000,
        }));
      }
    } finally {
      setExecuting((prev) => ({ ...prev, [attackId]: false }));
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

  const formatTime = (timestamp: string) =>
    new Date(timestamp).toLocaleTimeString(
      locale === 'ja' ? 'ja-JP' : 'en-US',
      {
        hour: '2-digit',
        minute: '2-digit',
      },
    );

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t('gameday.attackDescription')}>
        {t('gameday.attackStation')}
      </Header>

      <Container
        header={<Header variant="h2">{t('gameday.targetSelection')}</Header>}
      >
        <FormField label={t('common.targetTeam')}>
          <Select
            selectedOption={selectedTarget}
            onChange={({ detail }) => setSelectedTarget(detail.selectedOption)}
            options={teamOptions}
            placeholder={t('common.selectTeam')}
            filteringType="auto"
          />
        </FormField>
      </Container>

      <Cards
        header={
          <Header counter={`(${catalog.length})`}>
            {t('gameday.attackName')}
          </Header>
        }
        items={catalog}
        cardsPerRow={[
          { cards: 1 },
          { minWidth: 400, cards: 2 },
          { minWidth: 700, cards: 3 },
        ]}
        cardDefinition={{
          header: (attack) => attack.name,
          sections: [
            {
              id: 'type',
              content: (attack) => (
                <Badge
                  color={attack.attackType === 'vulnerability' ? 'red' : 'blue'}
                >
                  {attack.attackType === 'vulnerability'
                    ? t('gameday.vulnerability')
                    : t('gameday.chaos')}
                </Badge>
              ),
            },
            {
              id: 'desc',
              header: locale === 'ja' ? '説明' : 'Description',
              content: (attack) => (
                <Box color="text-body-secondary">{attack.description}</Box>
              ),
            },
            {
              id: 'stats',
              content: (attack) => (
                <SpaceBetween direction="horizontal" size="l">
                  <Box variant="small">
                    {t('gameday.cost')}: <b>{attack.purchaseCost}</b>
                  </Box>
                  <Box variant="small">
                    {t('gameday.damage')}: <b>{attack.damage}</b>
                  </Box>
                  <Box variant="small">
                    {t('gameday.reward')}: <b>{attack.reward}</b>
                  </Box>
                </SpaceBetween>
              ),
            },
            {
              id: 'action',
              content: (attack) => {
                const purchased = purchasedIds.has(attack.id);
                const onCooldown =
                  cooldowns[attack.id] && Date.now() < cooldowns[attack.id];

                return purchased ? (
                  <Button
                    variant="primary"
                    fullWidth
                    onClick={() => handleExecute(attack.id)}
                    loading={executing[attack.id]}
                    disabled={!selectedTarget?.value || Boolean(onCooldown)}
                  >
                    {onCooldown
                      ? `${t('gameday.cooldown')}...`
                      : t('gameday.execute')}
                  </Button>
                ) : (
                  <Button
                    fullWidth
                    onClick={() => handlePurchase(attack.id)}
                    loading={purchasing[attack.id]}
                  >
                    {t('gameday.purchase')} ({attack.purchaseCost} pts)
                  </Button>
                );
              },
            },
          ],
        }}
        empty={t('common.noData')}
      />

      <Table
        header={
          <Header counter={`(${history.length})`}>
            {t('gameday.attackHistory')}
          </Header>
        }
        items={history}
        columnDefinitions={[
          {
            id: 'time',
            header: t('gameday.time'),
            cell: (log) => formatTime(log.createdAt),
            width: 100,
          },
          {
            id: 'attack',
            header: t('gameday.attackName'),
            cell: (log) => <Box variant="code">{log.attackSlug}</Box>,
          },
          {
            id: 'target',
            header: t('gameday.target'),
            cell: (log) => log.defenderTeamId,
          },
          {
            id: 'result',
            header: t('gameday.result'),
            cell: (log) => (
              <StatusIndicator type={log.success ? 'success' : 'error'}>
                {log.success ? t('gameday.success') : t('gameday.failed')}
              </StatusIndicator>
            ),
            width: 120,
          },
          {
            id: 'reward',
            header: t('gameday.reward'),
            cell: (log) =>
              log.success ? (
                <Box color="text-status-success">+{log.reward}</Box>
              ) : (
                '0'
              ),
            width: 100,
          },
        ]}
        empty={t('gameday.noAttackHistory')}
        sortingDisabled
      />
    </SpaceBetween>
  );
}
