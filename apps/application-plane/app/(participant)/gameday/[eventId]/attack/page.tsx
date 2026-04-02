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

export default function AttackPage() {
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
        const opts = data.teams
          .filter((team) => team.teamId !== teamId)
          .map((team) => ({
            value: team.teamId,
            label: team.teamName,
          }));
        setTeamOptions(opts);
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
      const e = err as Error & { status?: number; body?: CooldownError };
      if (e.status === 429 && e.body?.remainingSeconds) {
        setCooldowns((prev) => ({
          ...prev,
          [attackId]: Date.now() + (e.body?.remainingSeconds ?? 0) * 1000,
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
            <Button onClick={fetchData}>再試行</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <SpaceBetween size="l">
      <Header variant="h1">攻撃ステーション</Header>

      {/* Target Selection */}
      <Container>
        <FormField label="ターゲットチーム">
          <Select
            selectedOption={selectedTarget}
            onChange={({ detail }) => setSelectedTarget(detail.selectedOption)}
            options={teamOptions}
            placeholder="ターゲットチームを選択"
            filteringType="auto"
          />
        </FormField>
      </Container>

      {/* Attack Catalog */}
      <Cards
        header={<Header counter={`(${catalog.length})`}>攻撃カタログ</Header>}
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
                  {attack.attackType}
                </Badge>
              ),
            },
            {
              id: 'desc',
              header: '説明',
              content: (attack) => (
                <Box color="text-body-secondary">{attack.description}</Box>
              ),
            },
            {
              id: 'stats',
              content: (attack) => (
                <SpaceBetween direction="horizontal" size="l">
                  <Box variant="small">
                    コスト: <b>{attack.purchaseCost}</b>
                  </Box>
                  <Box variant="small">
                    ダメージ: <b>{attack.damage}</b>
                  </Box>
                  <Box variant="small">
                    報酬: <b>{attack.reward}</b>
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
                    disabled={!selectedTarget?.value || onCooldown || false}
                  >
                    {onCooldown ? 'クールダウン中...' : '攻撃実行'}
                  </Button>
                ) : (
                  <Button
                    fullWidth
                    onClick={() => handlePurchase(attack.id)}
                    loading={purchasing[attack.id]}
                  >
                    購入 ({attack.purchaseCost} pts)
                  </Button>
                );
              },
            },
          ],
        }}
        empty="攻撃カタログが空です"
      />

      {/* Attack History */}
      <Table
        header={<Header counter={`(${history.length})`}>攻撃履歴</Header>}
        items={history}
        columnDefinitions={[
          {
            id: 'time',
            header: '時間',
            cell: (log) => formatTime(log.createdAt),
            width: 100,
          },
          {
            id: 'attack',
            header: '攻撃',
            cell: (log) => <Box variant="code">{log.attackSlug}</Box>,
          },
          {
            id: 'target',
            header: '対象',
            cell: (log) => log.defenderTeamId,
          },
          {
            id: 'result',
            header: '結果',
            cell: (log) => (
              <StatusIndicator type={log.success ? 'success' : 'error'}>
                {log.success ? '成功' : '失敗'}
              </StatusIndicator>
            ),
            width: 120,
          },
          {
            id: 'reward',
            header: '報酬',
            cell: (log) =>
              log.success ? (
                <Box color="text-status-success">+{log.reward}</Box>
              ) : (
                '0'
              ),
            width: 100,
          },
        ]}
        empty="攻撃履歴なし"
        sortingDisabled
      />
    </SpaceBetween>
  );
}
