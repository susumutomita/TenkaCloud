/**
 * Admin GameDay Real-time Dashboard
 *
 * ゲーム中のリアルタイム監視ダッシュボード
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Button from '@cloudscape-design/components/button';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type {
  GameState,
  LeaderboardEntry,
  AttackStats,
} from '@/lib/api/gameday-types';

const POLL_INTERVAL = 5000;

interface AttackLog {
  id: string;
  attackerTeamId: string;
  defenderTeamId: string;
  attackSlug: string;
  success: boolean;
  damage: number;
  createdAt: string;
}

export default function AdminGameDayDashboardPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [attackLogs, setAttackLogs] = useState<AttackLog[]>([]);
  const [attackStats, setAttackStats] = useState<AttackStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, lbRes, logsRes, statsRes] = await Promise.all([
        fetch(`/api/admin/gameday/status?eventId=${eventId}`),
        fetch(`/api/admin/gameday/leaderboard?eventId=${eventId}`),
        fetch(`/api/admin/gameday/attack-logs?eventId=${eventId}`),
        fetch(`/api/admin/gameday/attack-stats?eventId=${eventId}`),
      ]);

      if (statusRes.ok) {
        setGameState(await statusRes.json());
      }
      if (lbRes.ok) {
        const data = await lbRes.json();
        setLeaderboard(data.leaderboard ?? []);
      }
      if (logsRes.ok) {
        const data = await logsRes.json();
        setAttackLogs((data.logs ?? []).slice(0, 20));
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setAttackStats(data.stats ?? []);
      }

      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'データの取得に失敗しました',
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  if (loading) {
    return (
      <Box textAlign="center" padding="xl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error) {
    return (
      <Box textAlign="center" padding="xl">
        <SpaceBetween size="m">
          <StatusIndicator type="error">{error}</StatusIndicator>
          <Button onClick={fetchAll}>再読み込み</Button>
        </SpaceBetween>
      </Box>
    );
  }

  const elapsed = gameState?.startedAt
    ? Math.floor((Date.now() - new Date(gameState.startedAt).getTime()) / 60000)
    : 0;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button onClick={() => router.push(`/admin/gameday/${eventId}`)}>
            制御パネルに戻る
          </Button>
        }
      >
        リアルタイムダッシュボード
      </Header>

      {/* Game Status Bar */}
      <Container header={<Header variant="h2">ゲーム状態</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">ステータス</Box>
            {gameState?.isRunning ? (
              <StatusIndicator type="success">稼働中</StatusIndicator>
            ) : (
              <StatusIndicator type="stopped">停止</StatusIndicator>
            )}
          </div>
          <div>
            <Box variant="awsui-key-label">経過時間</Box>
            <Box>{elapsed} 分</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">スコア倍率</Box>
            <Badge color={gameState?.scoreWeight === 'high' ? 'red' : 'blue'}>
              {gameState?.scoreWeight === 'high' ? '2x' : '通常'}
            </Badge>
          </div>
          <div>
            <Box variant="awsui-key-label">ブラックアウト</Box>
            <Badge color={gameState?.blackout ? 'red' : 'green'}>
              {gameState?.blackout ? 'ON' : 'OFF'}
            </Badge>
          </div>
        </ColumnLayout>
      </Container>

      <ColumnLayout columns={2}>
        {/* Live Leaderboard */}
        <Container header={<Header variant="h2">リーダーボード</Header>}>
          <Table
            items={leaderboard}
            variant="embedded"
            columnDefinitions={[
              {
                id: 'rank',
                header: '順位',
                cell: (item) => `#${item.rank}`,
                width: 60,
              },
              {
                id: 'teamName',
                header: 'チーム',
                cell: (item) => item.teamName,
              },
              {
                id: 'score',
                header: 'スコア',
                cell: (item) => item.score.toLocaleString(),
                width: 100,
              },
              {
                id: 'attacks',
                header: '攻撃',
                cell: (item) => item.attacksLaunched,
                width: 60,
              },
            ]}
            empty="チームなし"
          />
        </Container>

        {/* Attack Timeline */}
        <Container header={<Header variant="h2">攻撃タイムライン</Header>}>
          <Table
            items={attackLogs}
            variant="embedded"
            columnDefinitions={[
              {
                id: 'time',
                header: '時刻',
                cell: (item) =>
                  new Date(item.createdAt).toLocaleTimeString('ja-JP'),
                width: 80,
              },
              {
                id: 'attacker',
                header: '攻撃者',
                cell: (item) => item.attackerTeamId,
              },
              {
                id: 'defender',
                header: '防御者',
                cell: (item) => item.defenderTeamId,
              },
              {
                id: 'type',
                header: '種別',
                cell: (item) => item.attackSlug,
                width: 120,
              },
              {
                id: 'result',
                header: '結果',
                cell: (item) =>
                  item.success ? (
                    <StatusIndicator type="success">成功</StatusIndicator>
                  ) : (
                    <StatusIndicator type="error">失敗</StatusIndicator>
                  ),
                width: 80,
              },
            ]}
            empty="攻撃ログなし"
          />
        </Container>
      </ColumnLayout>

      {/* Attack Stats */}
      {attackStats.length > 0 && (
        <Container header={<Header variant="h2">攻撃統計</Header>}>
          <Table
            items={attackStats}
            variant="embedded"
            columnDefinitions={[
              { id: 'name', header: '攻撃名', cell: (item) => item.attackName },
              {
                id: 'slug',
                header: 'スラッグ',
                cell: (item) => item.attackSlug,
              },
              {
                id: 'count',
                header: '実行数',
                cell: (item) => item.totalExecutions,
                width: 80,
              },
              {
                id: 'rate',
                header: '成功率',
                cell: (item) => `${Math.round(item.successRate * 100)}%`,
                width: 80,
              },
            ]}
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
