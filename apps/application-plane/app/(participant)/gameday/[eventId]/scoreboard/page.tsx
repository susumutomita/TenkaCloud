/**
 * Scoreboard (スコアボード)
 *
 * AWS GameDay 風 — 3タブ構成:
 *   Attack Statistics: チーム×攻撃のテーブル（フィルタ付き）
 *   Application Status: チーム×コンポーネントのヘルスチェックテーブル
 *   Attack History: 攻撃履歴テーブル
 *
 * リーダーボード、ブラックアウト時はロック画面表示。
 * 30秒ごとに自動リフレッシュ。
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import {
  getAttackStats,
  getLeaderboard,
  getParticipantTeams,
} from '@/lib/api/gameday';
import type {
  AttackStats,
  LeaderboardEntry,
  Team,
} from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

// --- Attack Statistics Tab ---
function AttackStatisticsTab({
  teams,
  stats,
  loading,
}: {
  teams: Team[];
  stats: AttackStats[];
  loading: boolean;
}) {
  const [teamFilter, setTeamFilter] = useState('');
  const [attackFilter, setAttackFilter] = useState('');
  const [vulnerableFilter, setVulnerableFilter] =
    useState<SelectProps.Option | null>({
      value: '',
      label: 'Any Vulnerable Status',
    });

  // Build rows: team × attack combinations
  const rows = teams.flatMap((team) =>
    stats.map((stat) => ({
      teamName: team.teamName,
      teamId: team.teamId,
      attackName: stat.attackName,
      attackSlug: stat.attackSlug,
      launched: stat.totalExecutions,
      nextAvailable: 'Now',
      received: 0,
      vulnerable: stat.successRate > 0.5 ? 'Yes' : 'No',
    }))
  );

  const filtered = rows.filter((r) => {
    if (
      teamFilter &&
      !r.teamName.toLowerCase().includes(teamFilter.toLowerCase())
    )
      return false;
    if (
      attackFilter &&
      !r.attackName.toLowerCase().includes(attackFilter.toLowerCase())
    )
      return false;
    if (vulnerableFilter?.value === 'yes' && r.vulnerable !== 'Yes')
      return false;
    if (vulnerableFilter?.value === 'no' && r.vulnerable !== 'No') return false;
    return true;
  });

  return (
    <Table
      columnDefinitions={[
        {
          id: 'teamName',
          header: 'Team Name',
          cell: (r) => r.teamName,
          sortingField: 'teamName',
        },
        {
          id: 'attackName',
          header: 'Attack Name',
          cell: (r) => <Box variant="code">{r.attackName}</Box>,
          sortingField: 'attackName',
        },
        {
          id: 'launched',
          header: 'Launched',
          cell: (r) => r.launched,
          sortingField: 'launched',
        },
        {
          id: 'nextAvailable',
          header: 'Next Available',
          cell: (r) => r.nextAvailable,
        },
        {
          id: 'received',
          header: 'Received',
          cell: (r) => r.received,
        },
        {
          id: 'vulnerable',
          header: 'Vulnerable?',
          cell: (r) =>
            r.vulnerable === 'Yes' ? (
              <StatusIndicator type="success">Yes</StatusIndicator>
            ) : r.vulnerable === 'Unknown' ? (
              <StatusIndicator type="warning">Unknown</StatusIndicator>
            ) : (
              <StatusIndicator type="error">No</StatusIndicator>
            ),
        },
      ]}
      items={filtered}
      loading={loading}
      loadingText="Loading attack data..."
      header={
        <Header
          description="Real-time data on attacks launched and received by teams"
          counter={`(${filtered.length})`}
        >
          Attack Statistics
        </Header>
      }
      filter={
        <SpaceBetween direction="horizontal" size="s">
          <Input
            placeholder="Filter by team name"
            value={teamFilter}
            onChange={({ detail }) => setTeamFilter(detail.value)}
          />
          <Input
            placeholder="Filter by attack name"
            value={attackFilter}
            onChange={({ detail }) => setAttackFilter(detail.value)}
          />
          <Select
            selectedOption={vulnerableFilter}
            onChange={({ detail }) =>
              setVulnerableFilter(detail.selectedOption)
            }
            options={[
              { value: '', label: 'Any Vulnerable Status' },
              { value: 'yes', label: 'Vulnerable' },
              { value: 'no', label: 'Not Vulnerable' },
            ]}
          />
        </SpaceBetween>
      }
      empty="No attack data available"
      sortingDisabled
    />
  );
}

// --- Application Status Tab ---
function ApplicationStatusTab({
  teams,
  loading,
}: {
  teams: Team[];
  loading: boolean;
}) {
  const [teamFilter, setTeamFilter] = useState('');

  const filtered = teams.filter(
    (t) =>
      !teamFilter || t.teamName.toLowerCase().includes(teamFilter.toLowerCase())
  );

  // The actual health check data would come from monitoring API
  // For now we show the team list with placeholder status
  return (
    <Table
      columnDefinitions={[
        {
          id: 'teamName',
          header: 'Team Name',
          cell: (t) => t.teamName,
          sortingField: 'teamName',
        },
        {
          id: 'apis',
          header: 'APIs',
          cell: () => <StatusIndicator type="error">Down</StatusIndicator>,
        },
        {
          id: 'dbReads',
          header: 'DB Reads',
          cell: () => <StatusIndicator type="error">Down</StatusIndicator>,
        },
        {
          id: 'dbWrites',
          header: 'DB Writes',
          cell: () => <StatusIndicator type="error">Down</StatusIndicator>,
        },
        {
          id: 'website',
          header: 'Website',
          cell: (t) =>
            t.websiteUrl ? (
              <StatusIndicator type="success">Up</StatusIndicator>
            ) : (
              <StatusIndicator type="error">Down</StatusIndicator>
            ),
        },
      ]}
      items={filtered}
      loading={loading}
      loadingText="Loading status data..."
      header={
        <Header description="Health monitoring of team application components">
          Application Status
        </Header>
      }
      filter={
        <Input
          placeholder="Filter by team name"
          value={teamFilter}
          onChange={({ detail }) => setTeamFilter(detail.value)}
        />
      }
      empty="No teams found"
      sortingDisabled
      footer={
        <Box textAlign="center" color="text-body-secondary" fontSize="body-s">
          <em>Refreshes every 30 seconds</em>
        </Box>
      }
    />
  );
}

// --- Attack History Tab ---
function AttackHistoryTab({
  stats,
  loading,
}: {
  stats: AttackStats[];
  loading: boolean;
}) {
  return (
    <Table
      columnDefinitions={[
        {
          id: 'attackName',
          header: 'Attack Name',
          cell: (s) => s.attackName,
          sortingField: 'attackName',
        },
        {
          id: 'attackSlug',
          header: 'Slug',
          cell: (s) => <Box variant="code">{s.attackSlug}</Box>,
        },
        {
          id: 'totalExecutions',
          header: 'Total Executions',
          cell: (s) => s.totalExecutions,
          sortingField: 'totalExecutions',
        },
        {
          id: 'successRate',
          header: 'Success Rate',
          cell: (s) => `${Math.round(s.successRate * 100)}%`,
          sortingField: 'successRate',
        },
      ]}
      items={stats}
      loading={loading}
      loadingText="Loading attack history..."
      header={
        <Header description="Aggregate attack execution statistics">
          Attack History
        </Header>
      }
      empty="No attack history available"
      sortingDisabled
    />
  );
}

// --- Main Scoreboard Page ---
export default function ScoreboardPage() {
  const { eventId, teamId } = useGamedaySession();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [attackStats, setAttackStats] = useState<AttackStats[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [blackout, setBlackout] = useState(false);
  const [activeTab, setActiveTab] = useState('attack-stats');

  const fetchData = useCallback(async () => {
    if (!eventId) return;
    try {
      const [lbData, statsData, teamsData] = await Promise.all([
        getLeaderboard(eventId),
        getAttackStats(eventId),
        getParticipantTeams(eventId),
      ]);
      setLeaderboard(lbData.leaderboard);
      setAttackStats(statsData.stats);
      setTeams(teamsData.teams);
      setBlackout(false);
      setError(null);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) {
        setBlackout(true);
        setError(null);
      } else {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました')
        );
      }
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (blackout) {
    return (
      <Box textAlign="center" padding="xxl">
        <SpaceBetween size="m" alignItems="center">
          <Box fontSize="display-l">🔒</Box>
          <Box
            fontSize="heading-xl"
            fontWeight="bold"
            color="text-status-error"
          >
            BLACKOUT
          </Box>
          <Box color="text-body-secondary">
            スコアボードは現在ブラックアウト中です。順位は非公開になっています。
          </Box>
        </SpaceBetween>
      </Box>
    );
  }

  if (error) {
    return (
      <Box textAlign="center" padding="xl">
        <SpaceBetween size="m">
          <StatusIndicator type="error">{error.message}</StatusIndicator>
          <Button onClick={fetchData}>再試行</Button>
        </SpaceBetween>
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      {/* Leaderboard Table */}
      <Table
        columnDefinitions={[
          {
            id: 'rank',
            header: 'Rank',
            cell: (entry) => (
              <Box fontWeight="bold">
                {entry.rank === 1 ? '🏆 ' : ''}
                {entry.rank}
              </Box>
            ),
            width: 80,
            sortingField: 'rank',
          },
          {
            id: 'teamName',
            header: 'Team Name',
            cell: (entry) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Box fontWeight="bold">{entry.teamName}</Box>
                {entry.teamId === teamId && (
                  <StatusIndicator type="info">自チーム</StatusIndicator>
                )}
              </SpaceBetween>
            ),
            sortingField: 'teamName',
          },
          {
            id: 'score',
            header: 'Score',
            cell: (entry) => (
              <Box fontWeight="bold">{entry.score.toLocaleString()}</Box>
            ),
            width: 150,
            sortingField: 'score',
          },
          {
            id: 'attacksLaunched',
            header: 'Attacks',
            cell: (entry) => entry.attacksLaunched,
            width: 100,
          },
          {
            id: 'attacksReceived',
            header: 'Received',
            cell: (entry) => entry.attacksReceived,
            width: 100,
          },
          {
            id: 'vulnerabilitiesFixed',
            header: 'Fixed',
            cell: (entry) => entry.vulnerabilitiesFixed,
            width: 100,
          },
        ]}
        items={leaderboard}
        loadingText="読み込み中"
        header={
          <Header
            description="Security Battle Royale — TenkaCloud GameDay"
            counter={`(${leaderboard.length} teams)`}
          >
            Leaderboard
          </Header>
        }
        empty="No leaderboard data"
        sortingDisabled
        footer={
          <Box textAlign="center" color="text-body-secondary" fontSize="body-s">
            <em>Refreshes every 30 seconds</em>
          </Box>
        }
      />

      {/* Tabs: Attack Statistics / Application Status / Attack History */}
      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setActiveTab(detail.activeTabId)}
        tabs={[
          {
            id: 'attack-stats',
            label: 'Attack Statistics',
            content: (
              <AttackStatisticsTab
                teams={teams}
                stats={attackStats}
                loading={loading}
              />
            ),
          },
          {
            id: 'app-status',
            label: 'Application Status',
            content: <ApplicationStatusTab teams={teams} loading={loading} />,
          },
          {
            id: 'attack-history',
            label: 'Attack History',
            content: <AttackHistoryTab stats={attackStats} loading={loading} />,
          },
        ]}
      />
    </SpaceBetween>
  );
}
