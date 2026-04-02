/**
 * Defense Trench (防衛塹壕)
 *
 * Cloudscape Design System — 受けている攻撃一覧、ヒント購入、脆弱性修正報告
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import { getActiveDefense, purchaseHint, reportFix } from '@/lib/api/gameday';
import type { AttackLog } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

export default function DefensePage() {
  const { eventId, teamId } = useGamedaySession();
  const [attacks, setAttacks] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [hintLoading, setHintLoading] = useState<Record<string, boolean>>({});
  const [fixLoading, setFixLoading] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const data = await getActiveDefense(eventId, teamId);
      setAttacks(data.attacks);
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
            <Button onClick={fetchData}>再試行</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const active = attacks.filter((a) => !a.neutralized);
  const neutralized = attacks.filter((a) => a.neutralized);

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  return (
    <SpaceBetween size="l">
      <Header variant="h1">防衛塹壕</Header>

      {/* Active Attacks */}
      <Table
        header={
          <Header
            counter={`(${active.length})`}
            description="現在受けている攻撃"
          >
            攻撃を受けている
          </Header>
        }
        items={active}
        columnDefinitions={[
          {
            id: 'attack',
            header: '攻撃',
            cell: (atk) => <Box variant="code">{atk.attackSlug}</Box>,
          },
          {
            id: 'attacker',
            header: '攻撃元',
            cell: (atk) => atk.attackerTeamId,
          },
          {
            id: 'damage',
            header: 'ダメージ',
            cell: (atk) => <Box color="text-status-error">{atk.damage}</Box>,
            width: 100,
          },
          {
            id: 'time',
            header: '時間',
            cell: (atk) => formatTime(atk.createdAt),
            width: 120,
          },
          {
            id: 'hint',
            header: 'ヒント',
            cell: (atk) =>
              hints[atk.attackId] ? (
                <StatusIndicator type="info">
                  {hints[atk.attackId]}
                </StatusIndicator>
              ) : (
                <Button
                  variant="link"
                  loading={hintLoading[atk.attackId]}
                  onClick={() => handlePurchaseHint(atk.attackId)}
                >
                  ヒント購入
                </Button>
              ),
          },
          {
            id: 'fix',
            header: '修正',
            cell: (atk) => (
              <Button
                variant="primary"
                loading={fixLoading[atk.attackSlug]}
                onClick={() => handleReportFix(atk.attackSlug)}
              >
                修正報告
              </Button>
            ),
            width: 130,
          },
        ]}
        empty="現在攻撃を受けていません"
        sortingDisabled
        footer={
          <Box textAlign="center" color="text-body-secondary" fontSize="body-s">
            <em>10秒ごとに自動更新</em>
          </Box>
        }
      />

      {/* Neutralized */}
      {neutralized.length > 0 && (
        <Table
          header={<Header counter={`(${neutralized.length})`}>修正済み</Header>}
          items={neutralized}
          columnDefinitions={[
            {
              id: 'attack',
              header: '攻撃',
              cell: (atk) => <Box variant="code">{atk.attackSlug}</Box>,
            },
            {
              id: 'attacker',
              header: '攻撃元',
              cell: (atk) => atk.attackerTeamId,
            },
            {
              id: 'status',
              header: 'ステータス',
              cell: () => (
                <StatusIndicator type="success">修正済み</StatusIndicator>
              ),
            },
            {
              id: 'time',
              header: '時間',
              cell: (atk) => formatTime(atk.createdAt),
              width: 120,
            },
          ]}
          empty=""
          sortingDisabled
        />
      )}
    </SpaceBetween>
  );
}
