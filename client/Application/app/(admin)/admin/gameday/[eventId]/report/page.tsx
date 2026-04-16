/**
 * Post-Game Report Page
 *
 * Cloudscape Design System - GameDay 終了後レポート
 * 経営層向けに結果を共有するためのレポートページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { gamedayRequest } from '@/lib/api/gameday';
import type {
  AttackStats,
  GameState,
  LeaderboardEntry,
} from '@/lib/api/gameday-types';
import { getGameStatus, getTeams } from '@/lib/api/gameday-admin';
import type { Team } from '@/lib/api/gameday-types';

// =============================================================================
// Types
// =============================================================================

interface ReportData {
  gameState: GameState;
  teams: Team[];
  leaderboard: LeaderboardEntry[];
  attackStats: AttackStats[];
}

// =============================================================================
// Helpers
// =============================================================================

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function generateCsv(leaderboard: LeaderboardEntry[]): string {
  const header = [
    '順位',
    'チーム名',
    '最終スコア',
    '攻撃実行数',
    '被攻撃数',
    '脆弱性修正数',
  ].join(',');

  const rows = leaderboard.map((entry) =>
    [
      entry.rank,
      `"${entry.teamName.replace(/"/g, '""')}"`,
      entry.score,
      entry.attacksLaunched,
      entry.attacksReceived,
      entry.vulnerabilitiesFixed,
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getTeamPerformanceSummary(entry: LeaderboardEntry): string {
  const parts: string[] = [];

  if (entry.rank === 1) {
    parts.push('総合優勝');
  } else if (entry.rank <= 3) {
    parts.push(`総合${entry.rank}位入賞`);
  }

  if (entry.attacksLaunched > 0) {
    parts.push(`${entry.attacksLaunched}回の攻撃を実行`);
  }

  if (entry.vulnerabilitiesFixed > 0) {
    parts.push(`${entry.vulnerabilitiesFixed}件の脆弱性を修正`);
  }

  if (entry.attacksReceived > 0) {
    parts.push(`${entry.attacksReceived}回の攻撃を受けた`);
  }

  if (parts.length === 0) {
    parts.push('活動なし');
  }

  return parts.join(' / ');
}

// =============================================================================
// Component
// =============================================================================

export default function GameDayReportPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [gameState, teamsData, leaderboardData, attackStatsData] =
        await Promise.all([
          getGameStatus(eventId),
          getTeams(eventId),
          gamedayRequest<{ leaderboard: LeaderboardEntry[] }>(
            '/dashboard/leaderboard',
            { params: { eventId } },
          ),
          gamedayRequest<{ stats: AttackStats[] }>('/dashboard/attack-stats', {
            params: { eventId },
          }),
        ]);

      setData({
        gameState,
        teams: teamsData.teams,
        leaderboard: leaderboardData.leaderboard,
        attackStats: attackStatsData.stats,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'レポートの取得に失敗しました',
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleCsvDownload = () => {
    if (!data) return;
    const csv = generateCsv(data.leaderboard);
    downloadCsv(csv, `gameday-report-${eventId}.csv`);
  };

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
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => router.push(`/admin/gameday/${eventId}`)}>
              コントロールパネルに戻る
            </Button>
            <Button onClick={fetchReport}>再読み込み</Button>
          </SpaceBetween>
        </SpaceBetween>
      </Box>
    );
  }

  if (!data) return null;

  const { gameState, teams, leaderboard, attackStats } = data;

  const sortedByCount = [...attackStats].sort(
    (a, b) => b.totalExecutions - a.totalExecutions,
  );
  const sortedBySuccess = [...attackStats].sort(
    (a, b) => b.successRate - a.successRate,
  );

  const durationText = `${gameState.durationMinutes}分`;

  return (
    <SpaceBetween size="l">
      {/* Header */}
      <Header
        variant="h1"
        description={`イベント ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="download" onClick={handleCsvDownload}>
              CSV ダウンロード
            </Button>
            <Button onClick={() => router.push(`/admin/gameday/${eventId}`)}>
              コントロールパネルに戻る
            </Button>
          </SpaceBetween>
        }
      >
        GameDay レポート
      </Header>

      {/* Event Summary */}
      <Container header={<Header variant="h2">イベント概要</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: 'イベント ID', value: eventId },
              { label: '設定時間', value: durationText },
              {
                label: '参加チーム数',
                value: `${teams.length} チーム`,
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: '開始時刻',
                value: gameState.startedAt
                  ? formatDateTime(gameState.startedAt)
                  : '-',
              },
              {
                label: 'ゲーム状態',
                value: gameState.isRunning ? (
                  <StatusIndicator type="success">稼働中</StatusIndicator>
                ) : (
                  <StatusIndicator type="stopped">終了</StatusIndicator>
                ),
              },
              {
                label: 'スコア重み',
                value:
                  gameState.scoreWeight === 'high' ? (
                    <Badge color="blue">2x</Badge>
                  ) : (
                    '通常'
                  ),
              },
            ]}
          />
        </ColumnLayout>
      </Container>

      {/* Final Rankings Table */}
      <Table
        header={
          <Header
            variant="h2"
            counter={`(${leaderboard.length})`}
            actions={
              <Button iconName="download" onClick={handleCsvDownload}>
                CSV ダウンロード
              </Button>
            }
          >
            最終ランキング
          </Header>
        }
        items={leaderboard}
        empty={
          <Box textAlign="center" padding="l">
            <Box variant="p" color="text-body-secondary">
              ランキングデータがありません
            </Box>
          </Box>
        }
        columnDefinitions={[
          {
            id: 'rank',
            header: '順位',
            cell: (item) => item.rank,
            sortingField: 'rank',
          },
          {
            id: 'teamName',
            header: 'チーム名',
            cell: (item) => (
              <Box fontWeight={item.rank <= 3 ? 'bold' : 'normal'}>
                {item.teamName}
              </Box>
            ),
            sortingField: 'teamName',
          },
          {
            id: 'score',
            header: '最終スコア',
            cell: (item) => `${item.score} pts`,
            sortingField: 'score',
          },
          {
            id: 'attacksLaunched',
            header: '攻撃実行数',
            cell: (item) => item.attacksLaunched,
            sortingField: 'attacksLaunched',
          },
          {
            id: 'attacksReceived',
            header: '被攻撃数',
            cell: (item) => item.attacksReceived,
            sortingField: 'attacksReceived',
          },
          {
            id: 'vulnerabilitiesFixed',
            header: '脆弱性修正数',
            cell: (item) => item.vulnerabilitiesFixed,
            sortingField: 'vulnerabilitiesFixed',
          },
        ]}
      />

      {/* Attack Statistics */}
      <ColumnLayout columns={2}>
        <Container
          header={<Header variant="h2">攻撃使用回数ランキング</Header>}
        >
          <Table
            items={sortedByCount}
            empty={
              <Box textAlign="center" padding="l">
                <Box variant="p" color="text-body-secondary">
                  攻撃統計がありません
                </Box>
              </Box>
            }
            columnDefinitions={[
              {
                id: 'attackName',
                header: '攻撃名',
                cell: (item) => item.attackName,
              },
              {
                id: 'totalExecutions',
                header: '実行回数',
                cell: (item) => item.totalExecutions,
              },
              {
                id: 'successRate',
                header: '成功率',
                cell: (item) => `${Math.round(item.successRate * 100)}%`,
              },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">攻撃成功率ランキング</Header>}>
          <Table
            items={sortedBySuccess}
            empty={
              <Box textAlign="center" padding="l">
                <Box variant="p" color="text-body-secondary">
                  攻撃統計がありません
                </Box>
              </Box>
            }
            columnDefinitions={[
              {
                id: 'attackName',
                header: '攻撃名',
                cell: (item) => item.attackName,
              },
              {
                id: 'successRate',
                header: '成功率',
                cell: (item) => `${Math.round(item.successRate * 100)}%`,
              },
              {
                id: 'totalExecutions',
                header: '実行回数',
                cell: (item) => item.totalExecutions,
              },
            ]}
          />
        </Container>
      </ColumnLayout>

      {/* Team Performance Summary */}
      <Container
        header={<Header variant="h2">チームパフォーマンスサマリー</Header>}
      >
        <SpaceBetween size="m">
          {leaderboard.map((entry) => (
            <Container
              key={entry.teamId}
              header={
                <Header
                  variant="h3"
                  info={
                    <Badge
                      color={
                        entry.rank === 1
                          ? 'blue'
                          : entry.rank <= 3
                            ? 'green'
                            : 'grey'
                      }
                    >
                      {entry.rank}位
                    </Badge>
                  }
                >
                  {entry.teamName}
                </Header>
              }
            >
              <ColumnLayout columns={4} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">最終スコア</Box>
                  <Box fontSize="heading-l" fontWeight="bold">
                    {entry.score} pts
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">攻撃実行</Box>
                  <Box>{entry.attacksLaunched}回</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">被攻撃</Box>
                  <Box>{entry.attacksReceived}回</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">脆弱性修正</Box>
                  <Box>{entry.vulnerabilitiesFixed}件</Box>
                </div>
              </ColumnLayout>
              <Box margin={{ top: 's' }}>
                <Box variant="awsui-key-label">パフォーマンス概要</Box>
                <Box>{getTeamPerformanceSummary(entry)}</Box>
              </Box>
            </Container>
          ))}
          {leaderboard.length === 0 && (
            <Box textAlign="center" padding="l">
              <Box variant="p" color="text-body-secondary">
                チームデータがありません
              </Box>
            </Box>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
