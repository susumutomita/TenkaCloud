/**
 * Scoreboard (スコアボード)
 *
 * リーダーボード、攻撃統計。ブラックアウト時はロック画面表示。
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
} from '@/components/ui';
import { getAttackStats, getLeaderboard } from '@/lib/api/gameday';
import type { AttackStats, LeaderboardEntry } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

function getRankStyle(rank: number) {
  switch (rank) {
    case 1:
      return 'bg-hn-warning/20 border-hn-warning';
    case 2:
      return 'bg-text-muted/20 border-text-muted';
    case 3:
      return 'bg-amber-500/20 border-amber-500';
    default:
      return 'bg-surface-1 border-border';
  }
}

export default function ScoreboardPage() {
  const { eventId, teamId } = useGamedaySession();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [stats, setStats] = useState<AttackStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [blackout, setBlackout] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId) return;
    try {
      const [lbData, statsData] = await Promise.all([
        getLeaderboard(eventId),
        getAttackStats(eventId),
      ]);
      setLeaderboard(lbData.leaderboard);
      setStats(statsData.stats);
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
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

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
        onRetry={fetchData}
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        スコアボード
      </h1>

      {/* Leaderboard */}
      <Card>
        <CardHeader>
          <span className="font-semibold text-text-primary">
            リーダーボード
          </span>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-2 border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                  順位
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                  チーム
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-text-muted uppercase">
                  スコア
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase">
                  攻撃
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase">
                  被撃
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase">
                  修正
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leaderboard.map((entry) => {
                const isMe = entry.teamId === teamId;
                return (
                  <tr
                    key={entry.teamId}
                    className={`${getRankStyle(entry.rank)} ${isMe ? 'ring-2 ring-hn-accent' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`font-bold ${entry.rank <= 3 ? 'text-xl' : 'text-text-primary'}`}
                      >
                        #{entry.rank}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">
                          {entry.teamName}
                        </span>
                        {isMe && (
                          <Badge variant="primary" size="sm">
                            自チーム
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-text-primary">
                      {entry.score.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-text-secondary">
                      {entry.attacksLaunched}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-text-secondary">
                      {entry.attacksReceived}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-hn-success">
                      {entry.vulnerabilitiesFixed}
                    </td>
                  </tr>
                );
              })}
              {leaderboard.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-text-muted text-sm"
                  >
                    データなし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Attack Stats */}
      {stats.length > 0 && (
        <Card>
          <CardHeader>
            <span className="font-semibold text-text-primary">攻撃統計</span>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stats.map((s) => (
                <div
                  key={s.attackSlug}
                  className="bg-surface-2 rounded-[var(--radius)] p-4 space-y-2"
                >
                  <div className="font-medium text-text-primary text-sm">
                    {s.attackName}
                  </div>
                  <div className="flex justify-between text-xs text-text-muted">
                    <span>実行数: {s.totalExecutions}</span>
                    <span>
                      成功率:{' '}
                      <span className="text-hn-accent font-mono">
                        {Math.round(s.successRate * 100)}%
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
