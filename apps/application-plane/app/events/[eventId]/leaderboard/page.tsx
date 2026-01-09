/**
 * Leaderboard Page
 *
 * イベントリーダーボードページ
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '../../../../components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
} from '../../../../components/ui';
import { getEventDetails, getLeaderboard } from '../../../../lib/api/events';
import type {
  EventDetails,
  Leaderboard,
  LeaderboardEntry,
} from '../../../../lib/api/types';

export default function LeaderboardPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [eventData, leaderboardData] = await Promise.all([
          getEventDetails(eventId),
          getLeaderboard(eventId),
        ]);
        setEvent(eventData);
        setLeaderboard(leaderboardData);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました')
        );
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // Poll for updates every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [eventId]);

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getRankStyle = (rank: number) => {
    switch (rank) {
      case 1:
        return 'bg-hn-warning/20 border-hn-warning text-hn-warning';
      case 2:
        return 'bg-text-muted/20 border-text-muted text-text-secondary';
      case 3:
        return 'bg-amber-500/20 border-amber-500 text-amber-400';
      default:
        return 'bg-surface-1 border-border';
    }
  };

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return '🥇';
      case 2:
        return '🥈';
      case 3:
        return '🥉';
      default:
        return `#${rank}`;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
        </div>
      </div>
    );
  }

  if (error || !leaderboard) {
    const displayError = error || new Error('not found');
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <ErrorState
            message={getErrorMessage(displayError)}
            type={getErrorType(displayError)}
            onRetry={() => window.location.reload()}
          />
          <div className="text-center mt-4">
            <Link href={`/events/${eventId}`}>
              <Button variant="ghost">イベントに戻る</Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const problemIds = event?.problems.map((p) => p.id) || [];

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6">
          <Link
            href={`/events/${eventId}`}
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            ← イベントに戻る
          </Link>
        </nav>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">
              リーダーボード
            </h1>
            {event && <p className="text-text-secondary">{event.name}</p>}
          </div>
          <div className="flex items-center gap-4">
            {leaderboard.isFrozen && (
              <Badge variant="warning" size="lg">
                ❄️ 凍結中
              </Badge>
            )}
            <div className="text-sm text-text-muted">
              最終更新: {formatTime(leaderboard.updatedAt)}
            </div>
          </div>
        </div>

        {/* My Position */}
        {leaderboard.myPosition && (
          <Card className="mb-6 bg-hn-accent/10 border-hn-accent">
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-2xl font-bold text-hn-accent">
                    #{leaderboard.myPosition}
                  </span>
                  <span className="font-medium text-text-primary">
                    あなたの順位
                  </span>
                </div>
                <span className="text-lg font-bold text-text-primary">
                  {leaderboard.entries.find((e) => e.isMe)?.totalScore ?? 0} pts
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Leaderboard Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-text-primary">
                全 {leaderboard.entries.length} チーム/参加者
              </span>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2 border-b border-border">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                    順位
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                    名前
                  </th>
                  {event?.problems.map((p, i) => (
                    <th
                      key={p.id}
                      className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase tracking-wider"
                    >
                      Q{i + 1}
                    </th>
                  ))}
                  <th className="px-6 py-3 text-right text-xs font-medium text-text-muted uppercase tracking-wider">
                    合計
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase tracking-wider">
                    推移
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leaderboard.entries.map((entry: LeaderboardEntry) => (
                  <tr
                    key={entry.teamId || entry.participantId}
                    className={`${getRankStyle(entry.rank)} ${entry.isMe ? 'ring-2 ring-hn-accent' : ''}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`font-bold ${entry.rank <= 3 ? 'text-xl' : 'text-text-primary'}`}
                      >
                        {getRankIcon(entry.rank)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            entry.isMe
                              ? 'font-bold text-text-primary'
                              : 'font-medium text-text-primary'
                          }
                        >
                          {entry.name}
                        </span>
                        {entry.isMe && (
                          <Badge variant="primary" size="sm">
                            自分
                          </Badge>
                        )}
                      </div>
                    </td>
                    {problemIds.map((problemId) => {
                      const score = entry.problemScores[problemId];
                      return (
                        <td
                          key={problemId}
                          className="px-4 py-4 text-center whitespace-nowrap"
                        >
                          {score !== undefined ? (
                            <span
                              className={
                                score > 0
                                  ? 'text-hn-success font-medium'
                                  : 'text-text-muted'
                              }
                            >
                              {score}
                            </span>
                          ) : (
                            <span className="text-text-muted">-</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      <span className="text-lg font-bold text-text-primary">
                        {entry.totalScore}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center whitespace-nowrap">
                      {entry.trend === 'up' && (
                        <span className="text-hn-success">↑</span>
                      )}
                      {entry.trend === 'down' && (
                        <span className="text-hn-error">↓</span>
                      )}
                      {entry.trend === 'same' && (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Empty State */}
        {leaderboard.entries.length === 0 && (
          <Card className="text-center py-12">
            <div className="text-4xl mb-4">📊</div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              まだ結果がありません
            </h2>
            <p className="text-text-secondary">
              イベントが開始されると結果が表示されます
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
