/**
 * Scoreboard (スコアボード)
 *
 * リーダーボード、攻撃統計。ブラックアウト時はロック画面表示。
 */

'use client';

import type { BoardProps } from '@cloudscape-design/board-components';
import Board from '@cloudscape-design/board-components/board';
import BoardItem from '@cloudscape-design/board-components/board-item';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  ErrorState,
  getErrorMessage,
  getErrorType,
} from '@/components/ui';
import { getAttackStats } from '@/lib/api/gameday';
import type { AttackStats, LeaderboardEntry } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useLeaderboardPolling } from '@/lib/hooks/use-leaderboard-polling';

interface BoardItemData {
  title: string;
  content: React.ReactNode;
}

type BoardLayoutItem = BoardProps.Item<BoardItemData>;

function LeaderboardTable({
  entries,
  teamId,
}: {
  entries: LeaderboardEntry[];
  teamId: string | null;
}) {
  return (
    <Table
      columnDefinitions={[
        {
          id: 'rank',
          header: '順位',
          cell: (entry) => `#${entry.rank}`,
          width: 70,
        },
        {
          id: 'teamName',
          header: 'チーム',
          cell: (entry) => (
            <SpaceBetween direction="horizontal" size="xs">
              <span>{entry.teamName}</span>
              {entry.teamId === teamId && (
                <Badge variant="primary" size="sm">
                  自チーム
                </Badge>
              )}
            </SpaceBetween>
          ),
        },
        {
          id: 'score',
          header: 'スコア',
          cell: (entry) => entry.score.toLocaleString(),
          width: 100,
        },
        {
          id: 'attacksLaunched',
          header: '攻撃',
          cell: (entry) => entry.attacksLaunched,
          width: 70,
        },
        {
          id: 'attacksReceived',
          header: '被撃',
          cell: (entry) => entry.attacksReceived,
          width: 70,
        },
        {
          id: 'vulnerabilitiesFixed',
          header: '修正',
          cell: (entry) => entry.vulnerabilitiesFixed,
          width: 70,
        },
      ]}
      items={entries}
      loadingText="読み込み中"
      empty="データなし"
      variant="embedded"
    />
  );
}

function AttackStatsTable({ stats }: { stats: AttackStats[] }) {
  return (
    <Table
      columnDefinitions={[
        {
          id: 'attackName',
          header: '攻撃名',
          cell: (s) => s.attackName,
        },
        {
          id: 'attackSlug',
          header: 'スラッグ',
          cell: (s) => s.attackSlug,
          width: 150,
        },
        {
          id: 'totalExecutions',
          header: '実行数',
          cell: (s) => s.totalExecutions,
          width: 100,
        },
        {
          id: 'successRate',
          header: '成功率',
          cell: (s) => `${Math.round(s.successRate * 100)}%`,
          width: 100,
        },
      ]}
      items={stats}
      loadingText="読み込み中"
      empty="データなし"
      variant="embedded"
    />
  );
}

export default function ScoreboardPage() {
  const { eventId, teamId } = useGamedaySession();
  const { data: pollData, error: pollError } = useLeaderboardPolling(eventId);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [attackStats, setAttackStats] = useState<AttackStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [blackout, setBlackout] = useState(false);
  const [boardItems, setBoardItems] = useState<ReadonlyArray<BoardLayoutItem>>(
    [],
  );

  useEffect(() => {
    if (pollData) {
      setLeaderboard(
        pollData.entries.map((entry) => ({
          ...entry,
          attacksLaunched: 0,
          attacksReceived: 0,
          vulnerabilitiesFixed: 0,
        })),
      );
      setBlackout(false);
      setLoading(false);
    }
  }, [pollData]);

  useEffect(() => {
    if (pollError) {
      setError(new Error(pollError));
      setLoading(false);
    }
  }, [pollError]);

  // 攻撃統計はポーリングで取得（攻撃ログの集計は leaderboard-service にない）
  const fetchAttackStats = useCallback(async () => {
    if (!eventId) return;
    try {
      const statsData = await getAttackStats(eventId);
      setAttackStats(statsData.stats);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) {
        setBlackout(true);
      }
    }
  }, [eventId]);

  useEffect(() => {
    fetchAttackStats();
    const id = setInterval(fetchAttackStats, 10000);
    return () => clearInterval(id);
  }, [fetchAttackStats]);

  useEffect(() => {
    setBoardItems([
      {
        id: 'leaderboard',
        rowSpan: 4,
        columnSpan: 2,
        data: {
          title: 'リーダーボード',
          content: (
            <LeaderboardTable entries={leaderboard} teamId={teamId ?? null} />
          ),
        },
      },
      {
        id: 'attack-stats',
        rowSpan: 4,
        columnSpan: 2,
        data: {
          title: '攻撃統計',
          content: <AttackStatsTable stats={attackStats} />,
        },
      },
    ]);
  }, [leaderboard, attackStats, teamId]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (blackout) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <div className="text-6xl">🔒</div>
        <h2 className="text-2xl font-bold text-hn-error">BLACKOUT</h2>
        <p className="text-text-secondary">
          スコアボードは現在ブラックアウト中です。順位は非公開になっています。
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        message={getErrorMessage(error)}
        type={getErrorType(error)}
        onRetry={fetchAttackStats}
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        スコアボード
      </h1>

      <Board
        renderItem={(
          item: BoardProps.Item<BoardItemData>,
          _actions: BoardProps.ItemActions,
        ) => (
          <BoardItem
            header={<Header>{item.data.title}</Header>}
            i18nStrings={{
              dragHandleAriaLabel: 'ドラッグハンドル',
              dragHandleAriaDescription:
                'スペースキーを押してドラッグを開始し、矢印キーで移動、スペースキーで確定、Escapeキーでキャンセル。',
              resizeHandleAriaLabel: 'リサイズハンドル',
              resizeHandleAriaDescription:
                'スペースキーを押してリサイズを開始し、矢印キーで変更、スペースキーで確定、Escapeキーでキャンセル。',
            }}
          >
            {item.data.content}
          </BoardItem>
        )}
        items={boardItems}
        onItemsChange={(event) => {
          setBoardItems(event.detail.items as BoardLayoutItem[]);
        }}
        i18nStrings={{
          liveAnnouncementDndStarted: (operationType) =>
            operationType === 'resize' ? 'リサイズ開始' : '移動開始',
          liveAnnouncementDndItemReordered: () => '順序変更',
          liveAnnouncementDndItemResized: () => 'リサイズ変更',
          liveAnnouncementDndItemInserted: () => '挿入',
          liveAnnouncementDndCommitted: () => '変更を確定',
          liveAnnouncementDndDiscarded: () => '変更を破棄',
          liveAnnouncementItemRemoved: () => 'アイテムを削除',
          navigationAriaLabel: 'ボードナビゲーション',
          navigationAriaDescription:
            'ボード内を移動するにはクリックしてください',
          navigationItemAriaLabel: (
            item: BoardProps.Item<BoardItemData> | null,
          ) => item?.data.title ?? '',
        }}
        empty="データなし"
      />
    </div>
  );
}
