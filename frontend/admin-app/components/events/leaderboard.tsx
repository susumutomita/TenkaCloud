'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getLeaderboard, type Leaderboard as LeaderboardType, type LeaderboardEntry } from '@/lib/api/events';

interface LeaderboardProps {
  eventId: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

const trendIcons = {
  up: (
    <svg className="h-4 w-4 text-green-500" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
    </svg>
  ),
  down: (
    <svg className="h-4 w-4 text-red-500" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V5a1 1 0 012 0v7.586l2.293-2.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  ),
  same: (
    <svg className="h-4 w-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
    </svg>
  ),
};

function getRankBadge(rank: number) {
  if (rank === 1) {
    return <span className="text-2xl">🥇</span>;
  }
  if (rank === 2) {
    return <span className="text-2xl">🥈</span>;
  }
  if (rank === 3) {
    return <span className="text-2xl">🥉</span>;
  }
  return (
    <span className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-700 font-medium">
      {rank}
    </span>
  );
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Leaderboard({ eventId, autoRefresh = true, refreshInterval = 30000 }: LeaderboardProps) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardType | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadLeaderboard = useCallback(async () => {
    try {
      const data = await getLeaderboard(eventId);
      setLeaderboard(data);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    loadLeaderboard();

    if (autoRefresh) {
      const interval = setInterval(loadLeaderboard, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [loadLeaderboard, autoRefresh, refreshInterval]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>リーダーボード</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 animate-pulse rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!leaderboard) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>リーダーボード</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            リーダーボードデータがありません
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle>リーダーボード</CardTitle>
            {leaderboard.isFrozen && (
              <Badge className="bg-blue-100 text-blue-800">
                凍結中
              </Badge>
            )}
          </div>
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              最終更新: {formatTime(lastUpdated.toISOString())}
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-2">
          {leaderboard.entries.map((entry, index) => (
            <div
              key={entry.teamId || entry.participantId}
              className={`flex items-center gap-4 p-3 rounded-lg ${
                index < 3 ? 'bg-gradient-to-r from-yellow-50 to-transparent' : 'bg-gray-50'
              }`}
            >
              {/* 順位 */}
              <div className="flex-shrink-0 w-10 flex justify-center">
                {getRankBadge(entry.rank)}
              </div>

              {/* チーム/参加者名 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{entry.name}</span>
                  {entry.trend && trendIcons[entry.trend]}
                </div>
                {entry.lastScoredAt && (
                  <span className="text-xs text-muted-foreground">
                    最終採点: {formatTime(entry.lastScoredAt)}
                  </span>
                )}
              </div>

              {/* 問題別スコア（省略表示） */}
              <div className="hidden md:flex items-center gap-1">
                {Object.entries(entry.problemScores).slice(0, 3).map(([problemId, score]) => (
                  <Badge key={problemId} variant="outline" className="text-xs">
                    {score}
                  </Badge>
                ))}
                {Object.keys(entry.problemScores).length > 3 && (
                  <span className="text-xs text-muted-foreground">
                    +{Object.keys(entry.problemScores).length - 3}
                  </span>
                )}
              </div>

              {/* 合計スコア */}
              <div className="flex-shrink-0 text-right">
                <span className="text-xl font-bold">{entry.totalScore}</span>
                <span className="text-xs text-muted-foreground block">pts</span>
              </div>
            </div>
          ))}
        </div>

        {leaderboard.entries.length === 0 && (
          <p className="text-muted-foreground text-center py-8">
            まだエントリーがありません
          </p>
        )}
      </CardContent>
    </Card>
  );
}
